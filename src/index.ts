/**
 * dsh-terminal 宿主侧（Node）入口：cordis apply 薄壳。
 *
 * 只做三件事：
 *   1. `webServer.registerUpgrade({ path: '/__dsh-terminal/ws' })` 挂 WS 桥
 *      （桥本体在与 cordis 无关的 ./bridge.ts，离线 e2e 直接复用）；
 *   2. `webServer.register({ kind: 'prefix', path: '/__dsh-terminal/assets' })`
 *      伺服插件自带字体（Nerd Font，p10k 字形）；
 *   3. `webServer.register({ kind: 'exact', path: '/__dsh-terminal/shells' })`
 *      伺服可用 shell 列表（M2 终端类型选择，detectShells 结果）；
 *   4. `ctx.effect` 注册全量清理。
 *
 * 规范约束：不 import 任何 @deepseek-ai/* 运行时值（链接挂载的插件解析不到），
 * 服务面用本地最小结构接口声明。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WsTerminalBridge } from './bridge.ts'
import type { TerminalSpawnSpec, TerminalHandle } from './bridge.ts'
import { detectShells, resolveShell } from './shell.ts'

export const name = 'dsh-terminal'

// ─── 运行时服务的本地最小结构接口（与 harness 源码签名对齐）────────────────

interface WebRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

interface WebServerLike {
  register(route: WebRoute): () => void
  registerUpgrade(route: WebUpgradeRoute): () => void
}

interface SubprocessLike {
  spawnTerminal(spec: TerminalSpawnSpec): Promise<TerminalHandle>
}

/** cordis Context 的最小面：本插件只用 get + effect + inject。 */
interface HostContextLike {
  get(name: string): unknown
  effect(fn: () => unknown, name?: string): unknown
  /**
   * cordis `ctx.inject`：声明服务依赖，待所需服务全部就绪后才执行回调；
   * 服务被替换/卸载时 cordis 自动 dispose 旧 fiber 并重跑回调。
   * web 组合里 `webServer` 服务是异步注册的，apply 时同步 `ctx.get` 会拿到
   * undefined，因此必须走 inject 等待（与 dsh-smooth-stream 同一模式）。
   */
  inject(deps: string[], callback: (ctx: HostContextLike) => unknown): unknown
}

// ─── 静态资源伺服（assets/fonts 下的 Nerd Font）────────────────────────────

const WS_PATH = '/__dsh-terminal/ws'
// webServer 的 prefix 匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
// 因此注册 path 不能带尾斜杠（否则拼成 '/__dsh-terminal/assets//' 永不匹配）。
const ASSETS_ROUTE = '/__dsh-terminal/assets'
/** 路由 handler 内部解析用前缀（带尾斜杠，配合 startsWith 取相对路径）。 */
const ASSETS_PREFIX = ASSETS_ROUTE + '/'
/** M2：可用 shell 列表 exact 路由（终端类型选择下拉的数据源）。 */
const SHELLS_ROUTE = '/__dsh-terminal/shells'
/** 构建产物在 lib/，assets 与 lib 同级。 */
const ASSETS_ROOT = fileURLToPath(new URL('../assets/', import.meta.url))

const CONTENT_TYPES: Record<string, string> = {
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
}

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return (dot >= 0 && CONTENT_TYPES[filePath.slice(dot)]) || 'application/octet-stream'
}

async function serveAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const notFound = (): void => {
    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (!pathname.startsWith(ASSETS_PREFIX)) return notFound()
    const rel = pathname.slice(ASSETS_PREFIX.length)
    if (rel.length === 0 || rel.includes('\0')) return notFound()
    const filePath = resolvePath(ASSETS_ROOT, rel)
    // 目录逃逸防护：解析结果必须仍在 assets 根内（ASSETS_ROOT 以分隔符结尾）。
    if (!filePath.startsWith(ASSETS_ROOT)) return notFound()
    const info = await stat(filePath)
    if (!info.isFile()) return notFound()
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': info.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    createReadStream(filePath).pipe(res)
  } catch {
    notFound()
  }
}

// ─── 可用 shell 列表（M2 终端类型选择）──────────────────────────────────────

/** `GET /__dsh-terminal/shells` → `{ shells: detectShells() }`，短缓存（30s）。 */
function serveShells(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' })
    res.end('method not allowed')
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=30',
  })
  res.end(JSON.stringify({ shells: detectShells() }))
}

// ─── 插件入口 ──────────────────────────────────────────────────────────────

export function apply(ctx: HostContextLike): void {
  // 依赖 webServer（挂 WS 桥 + 字体路由）与 subprocess（PTY 提供方，如
  // dsh-subprocess-local）两个服务。web 组合里服务异步注册，用 inject 等待；
  // 若插件被挂进不含这些服务的组合（非 web profile），回调不会执行——
  // 不抛错，以免拖垮整棵插件树的加载。
  ctx.inject(['webServer', 'subprocess'], (serviceCtx) => {
    const webServer = serviceCtx.get('webServer') as WebServerLike
    const subprocess = serviceCtx.get('subprocess') as SubprocessLike

    const bridge = new WsTerminalBridge({
      spawnTerminal: (spec) => subprocess.spawnTerminal(spec),
      resolveShell,
      // M2：spawn 帧 shell 字段的 allowlist 数据源（与 /shells 路由同一来源）。
      listShells: detectShells,
    })

    const disposeUpgrade = webServer.registerUpgrade({
      path: WS_PATH,
      handler: (req, socket, head) => { bridge.handleUpgrade(req, socket, head) },
    })
    const disposeAssets = webServer.register({
      kind: 'prefix',
      path: ASSETS_ROUTE,
      handler: (req, res) => serveAsset(req, res),
    })
    const disposeShells = webServer.register({
      kind: 'exact',
      path: SHELLS_ROUTE,
      handler: serveShells,
    })

    serviceCtx.effect(() => () => {
      disposeUpgrade()
      disposeAssets()
      disposeShells()
      bridge.dispose()
    }, 'dsh-terminal: ws bridge + asset/shells routes')
  })
}
