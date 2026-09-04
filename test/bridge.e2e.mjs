/**
 * dsh-terminal 离线 e2e：WS 桥 + 真 PTY（node-pty 注入 spawnTerminal 适配器）。
 *
 * 链路：http.createServer + WsTerminalBridge（server.on('upgrade') 转发）
 *   → ws 客户端发 spawn → 等 ready → 交互 → exit。
 *
 * 场景（M1 回归 + M2 shell 选择）：
 *   S1 默认 shell（无 shell 字段）→ ready.shell=resolveShell().name（本机 zsh）：
 *      提示符字节 → echo $ZSH_VERSION → resize(100,40) 后 stty 报 "40 100" → exit 0。
 *   S2 显式 shell='/bin/bash'（allowlist 字面命中或 realpath 别名命中）→
 *      ready.shell='bash' → echo $BASH_VERSION 非空 → exit 0。
 *   S3 非法 shell='/no/such/shell' → 收 error 帧（invalid shell），
 *      spawnTerminal 计数不变（不落 PTY），无 ready 帧。
 *   S4 远程 target（{kind:'ssh',connectionId,cwd}）+ 注入 resolveTarget →
 *      argv/cwd 被 resolver 返回替换，ready.shell=resolver 的 name（`ssh·pwn`）。
 *   S5 远程 target 但桥无 resolveTarget → 收 error 帧（no resolver），
 *      spawnTerminal 计数不变，无 ready 帧。
 *
 * 纯 node 运行：`node test/bridge.e2e.mjs`；进程退出码 0/非 0 表成败，30s 兜底。
 */

import http from 'node:http'
import { Readable } from 'node:stream'
import { WebSocket } from 'ws'
import pty from 'node-pty'
import { WsTerminalBridge } from '../src/bridge.ts'
import { resolveShell, detectShells } from '../src/shell.ts'

const WS_PATH = '/__dsh-terminal/ws'
const OVERALL_TIMEOUT_MS = 30_000

const log = (...args) => console.log('[e2e]', ...args)
const fail = (reason) => {
  console.error('[e2e] FAIL:', reason)
  process.exit(1)
}

process.on('unhandledRejection', (error) => fail(`unhandledRejection: ${error?.stack ?? error}`))

const watchdog = setTimeout(() => fail(`overall timeout (${OVERALL_TIMEOUT_MS}ms)`), OVERALL_TIMEOUT_MS)

/** node-pty → harness spawnTerminal 句柄面的适配器（离线等价物）。 */
const spawnTerminal = async (spec) => {
  spawnCount += 1
  const child = pty.spawn(spec.argv[0], spec.argv.slice(1), {
    name: 'xterm-256color',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
  })
  const output = new Readable({ read() {} })
  let settleExit
  const done = new Promise((resolve) => { settleExit = resolve })
  child.onData((data) => output.push(Buffer.from(data, 'utf8')))
  child.onExit(({ exitCode, signal }) => {
    output.push(null)
    settleExit({ exitCode, signal: signal === undefined ? null : String(signal) })
  })
  return {
    pid: child.pid,
    output,
    done,
    write(data) { child.write(data) },
    async terminate() {
      try { child.kill() } catch { /* already dead */ }
      await done.catch(() => {})
    },
    resize(cols, rows) { child.resize(cols, rows) },
  }
}

let spawnCount = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询直到谓词满足或超时。 */
const waitFor = async (label, predicate, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`waitFor timeout: ${label}`)
}

/** 打开一条 WS 连接并装配帧收集。 */
async function openConnection(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`)
  const sink = { output: '', ready: undefined, exit: undefined, errors: [] }
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      sink.output += Buffer.from(data).toString('utf8')
      return
    }
    const frame = JSON.parse(Buffer.from(data).toString('utf8'))
    if (frame.t === 'ready') sink.ready = frame
    else if (frame.t === 'exit') sink.exit = frame
    else if (frame.t === 'error') sink.errors.push(frame)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, sink }
}

/** S1：M1 回归——默认 shell（不带 shell 字段）全链路。 */
async function scenarioDefaultShell(port) {
  const { ws, sink } = await openConnection(port)
  ws.send(JSON.stringify({ t: 'spawn', cols: 80, rows: 24 }))
  await waitFor('S1 ready frame', () => sink.ready)
  if (typeof sink.ready.pid !== 'number' || sink.ready.pid <= 0) fail(`S1 bad ready pid: ${JSON.stringify(sink.ready)}`)
  const expectedDefault = resolveShell().name
  if (sink.ready.shell !== expectedDefault) fail(`S1 ready.shell=${sink.ready.shell}, want ${expectedDefault}`)
  log(`S1 ready: pid=${sink.ready.pid} shell=${sink.ready.shell}（默认 shell 回归）`)

  await sleep(2_000)
  if (sink.output.length === 0) fail('S1 no prompt bytes within 2s after spawn')

  const isZsh = sink.ready.shell === 'zsh'
  sink.output = ''
  if (isZsh) {
    ws.send(Buffer.from('echo ZV=$ZSH_VERSION\n', 'utf8'))
    await waitFor('S1 ZSH_VERSION echo', () => /ZV=\d+\.\d+/.test(sink.output))
    log(`S1 zsh version echoed: ${sink.output.match(/ZV=\d+\.\d+/)[0]}`)
  } else {
    ws.send(Buffer.from('echo E2E_ROUNDTRIP_OK\n', 'utf8'))
    await waitFor('S1 echo roundtrip', () => sink.output.includes('E2E_ROUNDTRIP_OK'))
    log('S1 echo roundtrip ok (non-zsh default)')
  }

  ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 40 }))
  await sleep(300)
  sink.output = ''
  ws.send(Buffer.from('echo SZ=$(stty size)-END\n', 'utf8'))
  await waitFor('S1 stty size after resize', () => sink.output.match(/SZ=(\d+) (\d+)-END/))
  const sizeMatch = sink.output.match(/SZ=(\d+) (\d+)-END/)
  if (sizeMatch[1] !== '40' || sizeMatch[2] !== '100') fail(`S1 resize not applied: got ${sizeMatch[1]} ${sizeMatch[2]}, want 40 100`)
  log(`S1 stty size: rows=${sizeMatch[1]} cols=${sizeMatch[2]}`)

  ws.send(Buffer.from('exit\n', 'utf8'))
  await waitFor('S1 exit frame', () => sink.exit)
  if (sink.exit.exitCode !== 0) fail(`S1 exit frame exitCode=${sink.exit.exitCode}, want 0`)
  log(`S1 exit: code=${sink.exit.exitCode} signal=${sink.exit.signal}`)
  ws.close()
}

/** S2：显式 shell='/bin/bash'（allowlist 命中，字面或 realpath 别名）。 */
async function scenarioBashShell(port) {
  const listed = detectShells().find((shell) => shell.name === 'bash')
  if (listed === undefined) fail('S2 detectShells() 未探测到 bash')
  const { ws, sink } = await openConnection(port)
  ws.send(JSON.stringify({ t: 'spawn', cols: 80, rows: 24, shell: '/bin/bash' }))
  await waitFor('S2 ready frame', () => sink.ready)
  if (sink.ready.shell !== 'bash') fail(`S2 ready.shell=${sink.ready.shell}, want bash`)
  log(`S2 ready: pid=${sink.ready.pid} shell=${sink.ready.shell}（'/bin/bash' → allowlist realpath 命中 ${listed.path}）`)

  sink.output = ''
  ws.send(Buffer.from('echo BV=$BASH_VERSION\n', 'utf8'))
  await waitFor('S2 BASH_VERSION echo', () => /BV=\d+\.\d+/.test(sink.output))
  log(`S2 bash version echoed: ${sink.output.match(/BV=\d+\.\d+/)[0]}`)

  ws.send(Buffer.from('exit\n', 'utf8'))
  await waitFor('S2 exit frame', () => sink.exit)
  if (sink.exit.exitCode !== 0) fail(`S2 exit frame exitCode=${sink.exit.exitCode}, want 0`)
  log(`S2 exit: code=${sink.exit.exitCode}`)
  ws.close()
}

/** S3：非法 shell 路径 → 只收 error 帧、不落 PTY（spawnTerminal 计数不变、无 ready）。 */
async function scenarioInvalidShell(port) {
  const { ws, sink } = await openConnection(port)
  const before = spawnCount
  ws.send(JSON.stringify({ t: 'spawn', cols: 80, rows: 24, shell: '/no/such/shell' }))
  await waitFor('S3 error frame', () => sink.errors.length > 0)
  if (!/invalid shell/.test(sink.errors[0].message ?? '')) fail(`S3 error message 不符: ${JSON.stringify(sink.errors[0])}`)
  await sleep(400)
  if (sink.ready !== undefined) fail('S3 非法 shell 竟然 ready 了（落 PTY）')
  if (spawnCount !== before) fail(`S3 spawnTerminal 计数变化 ${before}→${spawnCount}（非法 shell 落了 PTY）`)
  log(`S3 error frame: ${sink.errors[0].message}（未落 PTY，spawnTerminal 计数不变）`)
  ws.close()
}

/** S5：远程 target 但桥无 resolveTarget → error 帧（no resolver）、不落 PTY。 */
async function scenarioNoResolver(port) {
  const { ws, sink } = await openConnection(port)
  const before = spawnCount
  ws.send(JSON.stringify({ t: 'spawn', cols: 80, rows: 24, target: { kind: 'ssh', connectionId: 'conn_x', cwd: '/home/kali/pwn' } }))
  await waitFor('S5 error frame', () => sink.errors.length > 0)
  if (!/no resolver/.test(sink.errors[0].message ?? '')) fail(`S5 error message 不符: ${JSON.stringify(sink.errors[0])}`)
  await sleep(400)
  if (sink.ready !== undefined) fail('S5 无 resolver 竟然 ready 了（落 PTY）')
  if (spawnCount !== before) fail(`S5 spawnTerminal 计数变化 ${before}→${spawnCount}（无 resolver 落了 PTY）`)
  log(`S5 error frame: ${sink.errors[0].message}（未落 PTY，spawnTerminal 计数不变）`)
  ws.close()
}

/** S4：远程 target + resolveTarget 注入 → argv/cwd 替换、ready.shell=resolver name、链路可交互。 */
async function scenarioRemoteTarget() {
  const seen = { targets: [] }
  const resolveTarget = (target) => {
    seen.targets.push(target)
    return { argv: ['/bin/bash', '--noprofile', '--norc'], cwd: process.cwd(), name: 'ssh·pwn' }
  }
  const bridge = new WsTerminalBridge({ spawnTerminal, resolveShell, listShells: detectShells, resolveTarget, pingIntervalMs: 1_000 })
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname === WS_PATH) bridge.handleUpgrade(req, socket, head)
    else socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const { ws, sink } = await openConnection(port)
    ws.send(JSON.stringify({ t: 'spawn', cols: 80, rows: 24, target: { kind: 'ssh', connectionId: 'conn_kali', cwd: '/home/kali/pwn' } }))
    await waitFor('S4 ready frame', () => sink.ready)
    if (seen.targets.length !== 1) fail(`S4 resolver 调用次数=${seen.targets.length}，want 1`)
    const got = seen.targets[0]
    if (got.kind !== 'ssh' || got.connectionId !== 'conn_kali' || got.cwd !== '/home/kali/pwn') {
      fail(`S4 resolver 收到的 target 不符: ${JSON.stringify(got)}`)
    }
    if (sink.ready.shell !== 'ssh·pwn') fail(`S4 ready.shell=${sink.ready.shell}，want ssh·pwn（resolver name）`)
    sink.output = ''
    ws.send(Buffer.from('echo RT_ROUNDTRIP_OK\n', 'utf8'))
    await waitFor('S4 echo roundtrip', () => sink.output.includes('RT_ROUNDTRIP_OK'))
    ws.send(Buffer.from('exit\n', 'utf8'))
    await waitFor('S4 exit frame', () => sink.exit)
    log(`S4 remote target: resolver 收到 ssh/conn_kali//home/kali/pwn，ready.shell=ssh·pwn，交互回显+exit 全通`)
    ws.close()
  } finally {
    bridge.dispose()
    server.close()
  }
}

async function main() {
  const bridge = new WsTerminalBridge({ spawnTerminal, resolveShell, listShells: detectShells, pingIntervalMs: 1_000 })
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname === WS_PATH) bridge.handleUpgrade(req, socket, head)
    else socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  log(`http+ws listening on 127.0.0.1:${port}`)

  await scenarioDefaultShell(port)
  await scenarioBashShell(port)
  await scenarioInvalidShell(port)
  await scenarioNoResolver(port)

  bridge.dispose()
  server.close()
  await scenarioRemoteTarget() // 独立 server/bridge（注入 resolveTarget）
  clearTimeout(watchdog)
  log('PASS: S1 默认 shell + S2 bash 选择 + S3 非法 shell 拒绝 + S4 远程 target 解析 + S5 无 resolver 拒绝')
  process.exit(0)
}

main().catch((error) => fail(error?.stack ?? String(error)))