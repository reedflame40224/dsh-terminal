/**
 * WsTerminalBridge —— 与 cordis 无关的纯 Node WebSocket ⇄ PTY 桥。
 *
 * 构造注入 `{ spawnTerminal, resolveShell }`，插件 apply 只是薄壳；
 * 离线 e2e（test/bridge.e2e.mjs）用 node-pty 注入同一个适配器接口，
 * 因此桥的完整行为不依赖 dsh 进程即可验证。
 *
 * 协议（一条 WS = 一个终端会话）：
 *   C→S 文本帧 JSON：`{t:'spawn',cols,rows,cwd?,shell?}` / `{t:'resize',cols,rows}` / `{t:'kill'}`
 *   C→S 二进制帧：终端输入原始字节（收到后 `handle.write(str)`）
 *   S→C 二进制帧：PTY 输出原始字节（`handle.output` 管道数据）
 *   S→C 文本帧 JSON：`{t:'ready',pid,shell}` / `{t:'exit',exitCode,signal}` / `{t:'error',message}`
 *
 * 行为约束（SPEC）：
 *   - `spawn.shell`（M2，可选）：必须是 `listShells()` 返回的 path 之一
 *     （allowlist 校验，非法值只回 error 帧、不落 PTY）；缺省回落 resolveShell()；
 *   - spawn 前收到的二进制帧丢弃；
 *   - WS 关闭必须 terminate() PTY；
 *   - 30s ping 心跳，失活清理。
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex, Readable } from 'node:stream'
import { findAllowedShell } from './shell.ts'
import type { DetectedShell } from './shell.ts'

/** spawnTerminal 的入参（与 harness ctx.subprocess.spawnTerminal 的 spec 结构一致的最小面）。 */
export interface TerminalSpawnSpec {
  argv: string[]
  cwd: string
  env?: Record<string, string>
  rows: number
  cols: number
  graceMs: number
}

/** spawnTerminal 的句柄最小面（resize 是 harness 正在补的方法，按可选处理）。 */
export interface TerminalHandle {
  readonly pid: number
  readonly output: Readable
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  write(data: string): Promise<void> | void
  terminate(): Promise<void> | void
  resize?(cols: number, rows: number): Promise<void> | void
}

export type SpawnTerminal = (spec: TerminalSpawnSpec) => Promise<TerminalHandle>

/** 默认 shell 解析结果。 */
export interface ResolvedShell {
  argv: string[]
  name: string
}

export type ResolveShell = () => ResolvedShell

/** M2：可用 shell 列表提供者（detectShells），spawn 帧 shell 字段的 allowlist 数据源。 */
export type ListShells = () => DetectedShell[]

export interface WsTerminalBridgeDeps {
  spawnTerminal: SpawnTerminal
  resolveShell: ResolveShell
  /** M2：shell allowlist（detectShells 的 path 集合），spawn 帧 shell 字段必须命中其一。 */
  listShells: ListShells
  /** ping 心跳周期（默认 30_000ms）。 */
  pingIntervalMs?: number
  /** PTY TERM→KILL 清理宽限（默认 3_000ms）。 */
  graceMs?: number
}

/** 单连接会话状态。 */
interface SessionState {
  alive: boolean
  spawned: boolean
  exited: boolean
  handle: TerminalHandle | undefined
  cleaned: boolean
}

const DEFAULT_PING_INTERVAL_MS = 30_000
const DEFAULT_GRACE_MS = 3_000

/** 终端行列钳制（防畸形帧撑爆 PTY）。 */
function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(500, Math.max(1, n))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WsTerminalBridge {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly sessions = new Set<WebSocket>()
  private readonly liveness = new WeakMap<WebSocket, SessionState>()
  private readonly deps: WsTerminalBridgeDeps
  private heartbeat: NodeJS.Timeout | undefined

  constructor(deps: WsTerminalBridgeDeps) {
    this.deps = deps
    this.heartbeat = setInterval(() => this.sweep(), deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS)
    this.heartbeat.unref?.()
  }

  /** webServer.registerUpgrade 的 handler：把升级好的 socket 交给 ws。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (ws) => this.attach(ws))
  }

  /** 全量清理：停心跳、关所有会话（连带 terminate PTY）、关 wss。 */
  dispose(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    for (const ws of [...this.sessions]) this.teardown(ws)
    this.server.close()
  }

  private attach(ws: WebSocket): void {
    const state: SessionState = { alive: true, spawned: false, exited: false, handle: undefined, cleaned: false }
    this.sessions.add(ws)
    this.liveness.set(ws, state)
    ws.on('pong', () => { state.alive = true })
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      void this.onMessage(ws, state, raw, isBinary).catch((error) => {
        this.sendJson(ws, { t: 'error', message: errorMessage(error) })
      })
    })
    ws.on('close', () => this.teardown(ws))
    ws.on('error', () => this.teardown(ws))
  }

  /** WS 关闭/出错/桥析构时的统一清理：必须 terminate() 还活着的 PTY。 */
  private teardown(ws: WebSocket): void {
    const state = this.liveness.get(ws)
    if (state !== undefined && !state.cleaned) {
      state.cleaned = true
      const handle = state.handle
      state.handle = undefined
      if (handle !== undefined && !state.exited) {
        try { void handle.terminate()?.catch?.(() => {}) } catch { /* already gone */ }
      }
    }
    this.sessions.delete(ws)
    try { ws.close() } catch { /* already closed */ }
  }

  private sweep(): void {
    for (const ws of this.sessions) {
      const state = this.liveness.get(ws)
      if (state === undefined) continue
      if (!state.alive) {
        this.teardown(ws)
        try { ws.terminate() } catch { /* already gone */ }
        continue
      }
      state.alive = false
      try { ws.ping() } catch { /* handshake not finished etc. */ }
    }
  }

  private sendJson(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  private sendBinary(ws: WebSocket, chunk: Buffer | string): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
  }

  private async onMessage(ws: WebSocket, state: SessionState, raw: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary) {
      // spawn 前收到的二进制帧丢弃。
      const handle = state.handle
      if (handle === undefined || state.exited) return
      await handle.write(raw.toString('utf8'))
      return
    }

    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    } catch {
      this.sendJson(ws, { t: 'error', message: 'invalid JSON frame' })
      return
    }

    switch (frame.t) {
      case 'spawn':
        await this.spawn(ws, state, frame)
        return
      case 'resize': {
        const cols = clampDimension(frame.cols, 80)
        const rows = clampDimension(frame.rows, 24)
        const handle = state.handle
        // resize 是 harness 正在补的 handle 方法：缺失时静默忽略，存在时调用容错。
        if (handle !== undefined && typeof handle.resize === 'function') {
          try { await handle.resize(cols, rows) } catch { /* resize 失败不致命 */ }
        }
        return
      }
      case 'kill': {
        const handle = state.handle
        if (handle !== undefined && !state.exited) {
          try { await handle.terminate() } catch { /* exit 经 done 回报 */ }
        }
        return
      }
      default:
        this.sendJson(ws, { t: 'error', message: `unknown frame type: ${String(frame.t)}` })
    }
  }

  private async spawn(ws: WebSocket, state: SessionState, frame: Record<string, unknown>): Promise<void> {
    if (state.spawned) {
      this.sendJson(ws, { t: 'error', message: 'terminal already spawned for this connection' })
      return
    }
    state.spawned = true

    const cols = clampDimension(frame.cols, 80)
    const rows = clampDimension(frame.rows, 24)
    const cwd = typeof frame.cwd === 'string' && frame.cwd.length > 0 ? frame.cwd : process.cwd()

    // M2 终端类型选择：spawn.shell 必须是 listShells() 的 path 之一（allowlist）。
    // 非法值只回 error 帧、不落 PTY（会话仍标记已消费，保持一 WS 一会话语义）；
    // 缺省/非字符串回落 resolveShell()（M1 行为逐字节不变）。
    let shell = this.deps.resolveShell()
    const requested = frame.shell
    if (typeof requested === 'string' && requested.length > 0) {
      const matched = findAllowedShell(requested, this.deps.listShells())
      if (matched === undefined) {
        this.sendJson(ws, { t: 'error', message: `invalid shell: ${requested}` })
        return
      }
      shell = { argv: [matched.path], name: matched.name }
    }

    let handle: TerminalHandle
    try {
      handle = await this.deps.spawnTerminal({
        argv: shell.argv,
        cwd,
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        rows,
        cols,
        graceMs: this.deps.graceMs ?? DEFAULT_GRACE_MS,
      })
    } catch (error) {
      this.sendJson(ws, { t: 'error', message: `spawn failed: ${errorMessage(error)}` })
      return
    }

    // 连接可能在 spawn 等待期间已关闭。
    if (state.cleaned) {
      try { await handle.terminate() } catch { /* best effort */ }
      return
    }
    state.handle = handle

    handle.output.on('data', (chunk: Buffer | string) => this.sendBinary(ws, chunk))
    handle.output.on('error', (error: Error) => {
      this.sendJson(ws, { t: 'error', message: `pty output: ${errorMessage(error)}` })
    })
    handle.done.then(({ exitCode, signal }) => {
      state.exited = true
      this.sendJson(ws, { t: 'exit', exitCode, signal })
      try { ws.close(1000) } catch { /* already closed */ }
    }).catch((error: unknown) => {
      this.sendJson(ws, { t: 'error', message: `pty done: ${errorMessage(error)}` })
    })

    this.sendJson(ws, { t: 'ready', pid: handle.pid, shell: shell.name })
  }
}
