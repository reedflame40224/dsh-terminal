/**
 * 终端会话装配：xterm 实例 + WS 上行/下行 + 尺寸同步。
 *
 * 时序（SPEC）：等 Nerd Font 就绪 → `term.open(container)` → 等布局两帧稳定
 * → `fitAddon.fit()` → WS 连接 → 发 spawn → onData 二进制上行、onmessage 二进制
 * `term.write` → 此后一切尺寸变化走 ResizeObserver rAF 合帧 propose（见 G：
 * 方向感知调度——拉宽立即重排、收窄推迟到 PTY 重绘之后），PTY resize 由全局
 * **静默期同步**收敛发送：拖尾防抖（RESIZE_QUIET_MS=300ms），连续变化零发送，
 * 几何安静后至多一次，去重保留。
 *
 * 时序修正沿革（用户逐轮验收根因）：
 *   A. 字体度量漂移（变形首因）：Nerd Font @font-face 走 font-display:swap，
 *      异步加载期间 fit() 用回退等宽字体度量算 cols/rows → spawn 后字体就绪
 *      单元格变宽/变窄 → cols 漂移 → 后续内容与回滚错位（窄尺寸打印、宽尺寸
 *      显示的痕迹）。修法：open/fit/spawn 之前先等字体就绪
 *      （document.fonts.load + fonts.ready，总超时 ~1s 兜底，失败也继续；
 *      fontFaceSet.check 作快速路径）。
 *   B. 稳定 spawn（M3）：open 后立即 fit 时容器可能未完成排版，cols/rows 是错的，
 *      ready 后再纠正 → SIGWINCH → p10k 重绘（开局约 3 条重复提示符）。修法：
 *      open 后等两次 requestAnimationFrame（容器 0 宽则再等 ResizeObserver
 *      首次持宽回调）再 fit、再建 WS 发 spawn —— spawn 携带的 cols/rows 即
 *      最终正确值；ready 只在当前尺寸与 spawn 时不同才补发（sendResize 去重
 *      已覆盖相等情形）。
 *   C. 100ms 节流跟随（M4）：移除 M2 全抑制（拖拽期屏蔽一切 PTY resize 导致
 *      本地 reflow 与 PTY 宽度脱节、松手双重影），全部尺寸变化统一走 leading
 *      立即发 + trailing 合并的节流链，PTY 与显示近似同步。但验收发现：拉缩/
 *      拖拽期间容器尺寸连续变化，节流仍以 ~100ms 节奏持续发 WINCH → p10k 每次
 *      收到 WINCH 都做一次「擦除旧提示符（按旧行数）→ 重画」，而擦除计数在
 *      缓冲区被反复 fit reflow 期间永远对不上 → 每发一次留一条阶梯残影。
 *      节流只在发送侧收敛，救不了重排侧。
 *   D. 拖拽冻结几何 + 松手原子同步（M5）：拖拽期（beginResize → endResize）
 *      冻结终端几何——ResizeObserver 跳过 fit、连 rAF 都不排，零重排零 WINCH；
 *      松手一个 rAF 后 fit 一次并立即发送。拖拽场景干净了，但窗口拉缩等非
 *      拖拽来源仍走 M4 节流，p10k 阶梯残影依旧；且「拖拽冻结」与「拉缩中本地
 *      照常重排」是两个互相打架的心智模型，逐源分支难维护。
 *   E. 全局静默期同步（本版）：所有尺寸变化统一进同一条**拖尾静默防抖**链
 *      （单一路径，不再分拖拽/非拖拽）：term.onResize → handleResize →
 *      scheduleResize 更新 pendingSize 并重置 RESIZE_QUIET_MS 定时器；连续
 *      变化（拉缩/拖拽进行中）→ 定时器一直被重置 → 零 WINCH；几何安静 ~300ms
 *      后 flushResize 把合并的最新尺寸发一次（与 lastSent 去重，未变则零发送）。
 *      根因对齐：p10k 的擦除依赖重排稳定，静默期同步把「一次拉缩手势」收敛为
 *      「至多一次 WINCH」，与原生终端行为一致。beginResize/endResize 退化为
 *      拖拽边界的手动同步点——begin 清挂起定时器（防拖拽前 pending 发送落在
 *      拖拽中段触发），endResize 松手即静默点立即同步（不等 300ms）；不再冻结
 *      几何，xterm 本地 fit/重排全程照常（视觉流畅）。
 *   F. 渲染层脏格兜底（本版）：headless 实验已证明 buffer 层干净——拉宽方向
 *      当前时序无残影，残影锁定在浏览器渲染层（canvas/webgl 脏格、重绘遗漏，
 *      与早前 "clearr" 尾部残字同源，见 boot 中 WebGL 默认关闭注释）。兜底：
 *      每次实际发出 resize（flushResize 静默落点、endResize 松手同步）后调度
 *      两次 term.refresh(0, rows-1) 整屏强制重绘（~150ms 与 ~400ms，覆盖 p10k
 *      重绘字节到达前后；去抖重置不叠加）。@xterm/headless 无 refresh 方法，
 *      故 try/catch 静默跳过——该兜底仅存在于浏览器客户端。
 *   G. 方向感知调度（本版）：headless 矩阵（/tmp/dsh-term-repro）钉死新的
 *      buffer 层根因——**残影只在「缓冲已窄而提示符内容仍是宽版」时出现**：
 *      120 列满宽提示符行在缓冲先收窄时 reflow 折成两行，p10k 按旧行数擦除，
 *      折行半截残留（即「重复 ╭ 行」）；宽缓冲里重画窄内容永远干净（不折行、
 *      擦除行数对得上）。尺寸同步因此改为**方向感知**：ResizeObserver/公共
 *      fit 统一经 fitAddon.proposeDimensions() 取建议尺寸（不发生 reflow），
 *      与 term.cols/rows 比较后分路：
 *        · 拉宽（cols 增大或 rows 增大）：立即 term.resize——缓冲先宽、视觉
 *          贴合；PTY 同步仍走 RESIZE_QUIET_MS 静默防抖（松手立即发）。
 *        · 收窄（cols/rows 减小）：term.resize **推迟**——先让 PTY 走静默防抖
 *          收窄（松手立即发），发送成功后等 ~NARROW_DEFER_MS=150ms（p10k 在
 *          宽缓冲里完成窄版重绘、无折行）再一次性 term.resize 到**合并的最新
 *          目标**；期间尺寸继续变化只更新目标并重启延迟；方向翻转/dispose
 *          正确取消挂起的推迟 resize。
 *      拖拽中连续 fit 全部经该调度器：拉宽即时贴合、收窄留白到松手（松手后
 *      按新序一次性同步）。headless 四场景验证：收窄新序净 / 拉宽 A 序净 /
 *      对照 A 序收窄脏（重复 ╭ 行，实验有效）/ 连续收窄一次性同步净。
 *
 * 与 React 无关：Panel 挂载时 createTerminalSession，卸载时 dispose。
 * 装配为异步 boot（等字体/等布局），dispose 通过 cancelled 信号即刻中断 boot，
 * 保证连续开关面板、拖拽中途关闭面板均无悬挂等待与资源泄漏。
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export interface TerminalReadyInfo {
  pid: number
  shell: string
}

export interface TerminalExitInfo {
  exitCode: number | null
  signal: string | null
}

export interface TerminalSessionCallbacks {
  onReady?(info: TerminalReadyInfo): void
  onExit?(info: TerminalExitInfo): void
}

/** M2：会话装配选项。`shell` 是请求的 shell 绝对路径（/__dsh-terminal/shells
 *  allowlist 内），将会随 spawn 帧上行；缺省回落宿主默认 shell（M1 行为不变）。 */
export interface TerminalSessionOptions {
  shell?: string
}

export interface TerminalSession {
  /** 立即重算尺寸（非拖拽场景的兜底 fit）：propose → 方向感知调度（拉宽即刻贴合、收窄走静默防抖 + 推迟收缓冲）。 */
  fit(): void
  /** 拖拽开始：清掉挂起的静默定时器与收窄延迟——防拖拽前已有 pending 发送/推迟 resize 在拖拽中段触发；几何照常 propose。 */
  beginResize(): void
  /** 拖拽结束（松手即同步点）：rAF 等 React 刷完最终宽度后 propose，按方向立即同步（拉宽先收缓冲再发 PTY；收窄先发 PTY、~150ms 后再收缓冲；去重，未变则零发送）。 */
  endResize(): void
  dispose(): void
}

const WS_PATH = '/__dsh-terminal/ws'

// —— 尺寸同步与 boot 参数 ——
const RESIZE_QUIET_MS = 300 // 拖尾静默防抖窗口：连续尺寸变化不断重置定时器 → 拉缩/拖拽中零发送；几何安静到期才发一次
const NARROW_DEFER_MS = 150 // 收窄方向缓冲 resize 的推迟窗口：PTY 收窄发送成功后，等 p10k 在宽缓冲里完成窄版重绘再 term.resize
const FONT_SPEC = '13px "AtkynsonMono NFM"' // 与 Terminal fontSize/fontFamily 对齐
const FONT_WAIT_MS = 1000 // 字体就绪等待上限：超时/失败用回退字体度量继续

export function createTerminalSession(
  container: HTMLElement,
  callbacks: TerminalSessionCallbacks,
  options?: TerminalSessionOptions,
): TerminalSession {
  const term = new Terminal({
    allowProposedApi: true,
    allowTransparency: true,
    theme: { background: '#00000000' },
    fontFamily: '"AtkynsonMono NFM","MesloLGS NF",monospace',
    fontSize: 13,
    cursorBlink: true,
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.loadAddon(new WebLinksAddon())

  const encoder = new TextEncoder()
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'

  let disposed = false
  let spawned = false
  let exited = false // 收到 exit 帧后置位：WS 关闭通知不再重复刷「连接已断开」（M2 标签保留内容）
  let ws: WebSocket | null = null
  const requestedShell = options?.shell // M2：可选 shell（缺省回落默认）

  // —— PTY resize 发送（本版：方向感知调度 + 全局静默期同步）——
  //   尺寸同步分两半：
  //     1) 本地缓冲重排（term.resize 的时机）由方向决定（见 G）：
  //        · 拉宽：立即——缓冲先宽，p10k 稍后重绘宽内容，宽缓冲里永远干净；
  //        · 收窄：推迟 NARROW_DEFER_MS——先发 PTY，等 p10k 在宽缓冲里重绘
  //          出窄版提示符（不折行），再一次性 term.resize 到合并的最新目标。
  //     2) PTY 发送仍走同一条拖尾静默防抖链（RESIZE_QUIET_MS）：连续变化
  //        （拉缩/拖拽进行中）→ 定时器一直被重置 → 零 WINCH；几何安静 ~300ms
  //        后 flushResize 才把合并的最新尺寸发一次（与 lastSent 去重）。
  //   beginResize/endResize 仅作拖拽边界的手动同步点：
  //     beginResize 清掉挂起的静默定时器与收窄延迟（防拖拽前 pending 落在
  //     拖拽中段触发）；endResize 松手立即按最终尺寸与方向同步（不等 300ms）。
  //   于是「一次拉缩手势」至多一次 WINCH，且窄方向的重绘永远发生在宽缓冲。
  let lastSent: { cols: number; rows: number } | null = null
  let resizeTimer: ReturnType<typeof setTimeout> | undefined // 静默防抖定时器
  let pendingSize: { cols: number; rows: number } | null = null // 静默期内合并的最新尺寸（到期落点）
  let endResizeRaf = 0 // endResize 松手同步 rAF（等 React 刷完最终宽度；dispose 取消）

  // —— 收窄方向的推迟 buffer resize（见 G）——
  //   narrowTarget 是收窄方向「待落地」的最新目标：每次收窄 propose 都覆盖它
  //   （期间尺寸继续变化 → 合并取最新）；PTY 发送成功（或已提前收窄）后起
  //   NARROW_DEFER_MS 定时器，到期一次性 term.resize(narrowTarget)。
  //   取消：方向翻转（新 propose 拉宽）、beginResize（新拖拽开始）、dispose。
  let deferredNarrowTimer: ReturnType<typeof setTimeout> | undefined
  let narrowTarget: { cols: number; rows: number } | null = null

  // —— boot 生命周期内累积的一次性资源（dispose 一并清理） ——
  let dataSubscription: { dispose(): void } | null = null
  let resizeSubscription: { dispose(): void } | null = null
  let layoutObserver: ResizeObserver | null = null // 首帧持宽等待专用
  let resizeObserver: ResizeObserver | null = null // 后续容器尺寸跟踪
  let fitRaf = 0

  // 发送成功返回 true（实际发出了 resize 帧；未就绪/WS 未开/与 lastSent 相同
  // 则 false，调用方据此决定是否调度渲染层兜底整屏重绘）。去重：相同尺寸不发。
  const sendResize = (cols: number, rows: number): boolean => {
    if (disposed || spawned === false || ws === null || ws.readyState !== WebSocket.OPEN) return false
    if (lastSent !== null && lastSent.cols === cols && lastSent.rows === rows) return false // 去重：相同不发
    ws.send(JSON.stringify({ t: 'resize', cols, rows }))
    lastSent = { cols, rows }
    return true
  }

  // 静默防抖到期：发静默期内合并的最新一次（trailing）。连续变化时定时器被
  // scheduleResize 持续重置，到期只可能发生在几何真正安静 ~300ms 之后——
  // 一次拉缩手势收敛为至多一次发送。
  const flushResize = (): void => {
    resizeTimer = undefined
    if (pendingSize === null) return // 无待发尺寸：已 flush 或全部被去重
    const size = pendingSize
    pendingSize = null
    // sendResize 返回是否实际发出（去重未发/未就绪 → false）；真发了才调度
    // 渲染层兜底整屏重绘（flushResize 是静默落点之一，见 scheduleRefreshFallback）。
    if (sendResize(size.cols, size.rows)) scheduleRefreshFallback()
    // 收窄落点：flush 的尺寸仍窄于当前缓冲 → 延迟 buffer resize（即便本次因
    // 去重未发——PTY 可能早已收窄而缓冲还没跟上，见 G 与 routeProposedSize）。
    if (narrowTarget !== null && (size.cols < term.cols || size.rows < term.rows)) {
      armDeferredNarrow()
    }
  }

  const scheduleResize = (cols: number, rows: number): void => {
    pendingSize = { cols, rows }
    if (resizeTimer !== undefined) clearTimeout(resizeTimer) // 连续变化：重置静默窗口
    resizeTimer = setTimeout(flushResize, RESIZE_QUIET_MS)
  }

  const handleResize = (size: { cols: number; rows: number }): void => {
    if (!spawned) return // ready 前不转发（spawn 以后才同步）
    if (lastSent !== null && lastSent.cols === size.cols && lastSent.rows === size.rows) return
    scheduleResize(size.cols, size.rows)
  }

  // —— 取建议尺寸（fitAddon.proposeDimensions：只算不重排）——
  //   proposeDimensions 不会触发 reflow/onResize，是方向判断的第一手信息：
  //   与 term.cols/rows 比较 → 拉宽 / 收窄 / 未变，再决定 term.resize 时机。
  const safePropose = (): { cols: number; rows: number } | null => {
    try {
      const p = fitAddon.proposeDimensions()
      if (p === undefined || Number.isNaN(p.cols) || Number.isNaN(p.rows)) return null
      return { cols: Math.max(2, Math.floor(p.cols)), rows: Math.max(1, Math.floor(p.rows)) }
    } catch {
      return null // 容器可能已隐藏/未排版
    }
  }

  // 取消挂起的收窄延迟（方向翻转/新拖拽/dispose 共用）。
  const cancelDeferredNarrow = (): void => {
    if (deferredNarrowTimer !== undefined) {
      clearTimeout(deferredNarrowTimer)
      pendingTimers.delete(deferredNarrowTimer)
      deferredNarrowTimer = undefined
    }
  }

  // （重）起收窄延迟：PTY 收窄发送成功之后，等 NARROW_DEFER_MS 让 p10k 在
  // 宽缓冲里重绘出窄版提示符，再一次性把缓冲收到 **当前最新** 的 narrowTarget。
  // 重复触发 = 尺寸继续变化 → 合并最新目标（重启而非叠加）。
  const armDeferredNarrow = (): void => {
    cancelDeferredNarrow()
    const id = setTimeout(() => {
      pendingTimers.delete(id)
      deferredNarrowTimer = undefined
      applyDeferredNarrow()
    }, NARROW_DEFER_MS)
    // 登记进统一清理结构：dispose 一并清除
    pendingTimers.add(id)
    deferredNarrowTimer = id
  }

  // 收窄延迟到期：把缓冲 resize 到合并的最新窄版目标。此刻 p10k 已在宽缓冲里
  // 重绘完窄版提示符（≤ 目标宽度，不折行），term.resize 只是把缓冲收到同一
  // 尺寸——无 reflow 折行、擦除行数对得上 → 干净。term.resize 触发的 onResize
  // 会走 handleResize → 静默期 flush → sendResize 与 lastSent 去重 → 零发送。
  const applyDeferredNarrow = (): void => {
    if (disposed || narrowTarget === null) return
    const target = narrowTarget
    narrowTarget = null
    try {
      if (term.cols !== target.cols || term.rows !== target.rows) term.resize(target.cols, target.rows)
    } catch {
      /* 容器可能已隐藏 */
    }
  }

  // —— 方向感知调度器（G）：propose 成功后的唯一入口 ——
  //   immediate=false：observer/公共 fit 的连续路径——拉宽立即 resize（视觉
  //   贴合），收窄只收集目标 + 走静默防抖发 PTY（缓冲留白到静默落点/松手）。
  //   immediate=true：endResize 松手——不等静默期，立即按最终尺寸发 PTY。
  const routeProposedSize = (cols: number, rows: number, immediate: boolean): void => {
    if (disposed) return
    if (!spawned) {
      // ready 前无 PTY 可同步、无 p10k 重绘——缓冲直接 fit 就位（原行为）
      try { fitAddon.fit() } catch { /* 容器可能已隐藏 */ }
      return
    }
    const widening = cols > term.cols || rows > term.rows
    const narrowing = cols < term.cols || rows < term.rows
    if (!widening && !narrowing) return // 尺寸未变：零操作

    if (widening) {
      // 拉宽：缓冲先宽（立即贴合；宽缓冲里 p10k 重绘窄内容永远干净）。
      // 方向翻转：清掉挂起的收窄延迟与目标（缓冲从未收窄，无需补 apply）。
      cancelDeferredNarrow()
      narrowTarget = null
      try { term.resize(cols, rows) } catch { /* 容器可能已隐藏 */ }
      // term.resize 触发 onResize → handleResize → 静默防抖 → PTY；
      // immediate（松手）则跳过 300ms 等待，立即发最终尺寸。
      if (immediate) {
        if (sendResize(term.cols, term.rows)) scheduleRefreshFallback()
      }
      return
    }

    // 收窄：缓冲 resize 推迟（先发 PTY，等 p10k 在宽缓冲重绘后再收缓冲）。
    narrowTarget = { cols, rows } // 合并最新目标：期间继续变化则覆盖
    if (immediate) {
      // 松手：不等静默期，立即发最终尺寸；发送成功（或 PTY 已提前收窄）后
      // 起 NARROW_DEFER_MS 延迟，到期把缓冲收到最新 narrowTarget。
      if (sendResize(cols, rows)) scheduleRefreshFallback()
      if (cols < term.cols || rows < term.rows) armDeferredNarrow()
    } else {
      // 连续路径：走静默防抖（拖拽/拉缩中零发送，几何安静后 flush 落点发送
      // 成功 → 在 flushResize 里 armDeferredNarrow）。
      scheduleResize(cols, rows)
    }
  }

  // —— 渲染层脏格兜底：每次实际发送 resize 后的整屏强制重绘 ——
  //   背景与沿革：拉宽面板时提示符区有残影。headless 实验（@xterm/headless）
  //   已证明 buffer 层干净——拉宽方向当前时序无残影，字节流与屏幕模型都无误，
  //   残影锁定在浏览器渲染层脏格（canvas/webgl 重绘遗漏；与早前 "clearr" 尾部
  //   残字同一类根因，见 boot 里 WebGL 默认关闭的注释）。@xterm/xterm 的
  //   Terminal.refresh(start, end) 可强制渲染器重绘指定行区间；@xterm/headless
  //   没有该方法，故这套兜底只用在浏览器客户端（本文件），并防御包装。
  //   兜底时机：每次实际发出 resize（flushResize 静默落点 / endResize 松手同步）
  //   后，调度两次整屏 refresh(0, rows-1)：发送后 ~150ms 与 ~400ms，覆盖 p10k
  //   收到 WINCH 后重绘字节到达的前后时刻，强制浏览器渲染层重画整屏。
  //   去抖合并：已有挂起的兜底 refresh 则重置而非叠加——连续发送只保留按最后
  //   一次发送时刻起的两次脉冲，不累积定时器。
  const REFRESH_FALLBACK_DELAYS = [150, 400] as const // resize 发送后 ~150ms 与 ~400ms
  let refreshFallbackTimers: ReturnType<typeof setTimeout>[] = [] // 挂起中的兜底定时器（去抖/清理用）

  // 整屏强制重绘：term.refresh 包 try/catch——@xterm/headless 无该方法（未来
  // API 变化同理），静默跳过，由常规重绘/下一轮兜底覆盖，绝不让兜底本身报错。
  const refreshFullScreen = (): void => {
    try {
      term.refresh(0, term.rows - 1)
    } catch {
      /* refresh 不存在（headless）或渲染层临时不可用：静默跳过 */
    }
  }

  const scheduleRefreshFallback = (): void => {
    // 去抖：清掉上一组挂起的兜底定时器并重置（不叠加），再按本次发送时刻排两发。
    for (const id of refreshFallbackTimers) clearTimeout(id)
    refreshFallbackTimers = REFRESH_FALLBACK_DELAYS.map((delay) => {
      const id = setTimeout(() => {
        refreshFallbackTimers = refreshFallbackTimers.filter((tid) => tid !== id) // 自身已触发：移出挂起集合
        pendingTimers.delete(id)
        refreshFullScreen()
      }, delay)
      pendingTimers.add(id) // 登记进统一清理结构：dispose 一并清除
      return id
    })
  }

  // —— boot 异步装配：字体就绪 → open → 布局稳定 → fit → spawn ——
  // 全程与 cancelled 赛跑：dispose 即刻中断，连续开关/中途关闭无悬挂等待。
  let resolveCancelled: (() => void) | undefined
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve
  })
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const id = setTimeout(() => {
        pendingTimers.delete(id)
        resolve()
      }, ms)
      pendingTimers.add(id)
    })
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()))

  // A. 等 Nerd Font 就绪：check 快速路径；否则 load + ready 与 1s 超时赛跑。
  // 超时/失败也继续：以回退字体度量 fit，行列仍正确（只是非理想字体）。
  const waitForFont = async (): Promise<void> => {
    try {
      if (!document.fonts.check(FONT_SPEC)) {
        await Promise.race([document.fonts.load(FONT_SPEC), sleep(FONT_WAIT_MS), cancelled])
        if (disposed) return
      }
      await Promise.race([document.fonts.ready, sleep(FONT_WAIT_MS), cancelled])
    } catch {
      /* 离线/字体不可用：继续，不做重试 */
    }
  }

  // B. 等布局稳定：两帧 rAF 让容器完成首帧排版；仍 0 宽（动画起步）则等
  // ResizeObserver 首次持宽回调。目标：spawn 携带的 cols/rows 即最终正确值。
  const waitForLayout = async (): Promise<void> => {
    for (let i = 0; i < 2; i++) {
      await Promise.race([nextFrame(), cancelled])
      if (disposed) return
    }
    if (container.clientWidth > 0) return
    await Promise.race([
      new Promise<void>((resolve) => {
        const ro = new ResizeObserver(() => {
          if (container.clientWidth <= 0) return
          ro.disconnect()
          if (layoutObserver === ro) layoutObserver = null
          resolve()
        })
        layoutObserver = ro
        ro.observe(container)
      }),
      cancelled,
    ])
  }

  const boot = async (): Promise<void> => {
    // A. 字体就绪（总超时 ~1s，失败也继续）
    await waitForFont()
    if (disposed) return

    term.open(container)
    // WebGL 渲染加速改为「默认关闭、localStorage 开关启用」（键 dsh-terminal.renderer）。
    // 背景：终端输入 clear 在浏览器显示成 "clearr"（末字符重复）——PTY 字节流正确、
    // @xterm/headless 屏幕模型矩阵（unicode11 on/off × cols 80/100/120/160）均无法复现，
    // 嫌疑锁定在浏览器渲染器：WebGL 字形图集/脏格缓存在 Nerd Font + p10k 重绘序列下
    // 残留旧格（clear 最后的那个 r 是重绘前的残格）。故默认改用 canvas 渲染（行为与
    // headless 屏幕模型一致、便于排查）；需要 WebGL 时在 DevTools Console 执行
    //   localStorage.setItem('dsh-terminal.renderer', 'webgl')
    // 后刷新页面即可启用（构造/挂载失败仍回落 canvas 渲染）。
    if (localStorage.getItem('dsh-terminal.renderer') === 'webgl') {
      try {
        term.loadAddon(new WebglAddon())
      } catch {
        /* 无 WebGL 环境：canvas 已足够 */
      }
    }

    // B. 布局稳定后再 fit + spawn（spawn 尺寸即最终正确值）
    await waitForLayout()
    if (disposed) return
    try { fitAddon.fit() } catch { /* 容器尚未排版完成时由后续 observer 兜底 */ }

    // 输入/尺寸订阅（open 后建立）。
    dataSubscription = term.onData((data) => {
      if (ws !== null && ws.readyState === WebSocket.OPEN && spawned) ws.send(encoder.encode(data))
    })
    resizeSubscription = term.onResize(({ cols, rows }) => handleResize({ cols, rows }))

    // 容器尺寸变化（拖拽调宽、窗口拉缩等一切来源）→ rAF 合帧 propose →
    // 方向感知调度（G）：拉宽立即 term.resize（视觉贴合）、收窄只收集目标 +
    // 静默防抖发 PTY（缓冲留白到松手/静默落点）。spawn 前的 fit 仍直接走
    // fitAddon.fit()（handleResize 有 ready 前不转发的守卫，见 routeProposedSize）。
    resizeObserver = new ResizeObserver(() => {
      if (fitRaf !== 0) return
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0
        const proposed = safePropose()
        if (proposed === null) return // 容器隐藏/未排版：等下一次 observer 回调
        routeProposedSize(proposed.cols, proposed.rows, false)
      })
    })
    resizeObserver.observe(container)

    ws = new WebSocket(`${protocol}://${location.host}${WS_PATH}`)
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open', () => {
      if (disposed) return
      const size = { cols: term.cols, rows: term.rows }
      lastSent = size // spawn 携带的尺寸即基准：ready 时相同则不再补发
      const frame: Record<string, unknown> = { t: 'spawn', cols: size.cols, rows: size.rows }
      if (requestedShell !== undefined && requestedShell.length > 0) frame.shell = requestedShell
      ws?.send(JSON.stringify(frame))
    })
    ws.addEventListener('message', (event) => {
      if (disposed) return
      if (typeof event.data !== 'string') {
        term.write(new Uint8Array(event.data as ArrayBuffer))
        return
      }
      let frame: { t?: string; pid?: number; shell?: string; exitCode?: number | null; signal?: string | null; message?: string }
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      switch (frame.t) {
        case 'ready':
          spawned = true
          callbacks.onReady?.({ pid: frame.pid ?? 0, shell: frame.shell ?? '' })
          // 仅当当前实际尺寸与 spawn 时携带的不同才补发（sendResize 去重覆盖相等情形）
          sendResize(term.cols, term.rows)
          break
        case 'exit':
          exited = true
          callbacks.onExit?.({ exitCode: frame.exitCode ?? null, signal: frame.signal ?? null })
          term.write(`\r\n\x1b[2m[进程已退出 exitCode=${String(frame.exitCode)}${frame.signal != null ? ` signal=${frame.signal}` : ''}]\x1b[0m\r\n`)
          break
        case 'error':
          term.write(`\r\n\x1b[31m[终端错误] ${frame.message ?? 'unknown'}\x1b[0m\r\n`)
          break
      }
    })
    ws.addEventListener('close', () => {
      if (disposed) return
      // 已由 exit 帧上报过进程结束：不重复刷「连接已断开」（M2 退出标签保留内容可查看）。
      if (exited) return
      term.write('\r\n\x1b[2m[连接已断开]\x1b[0m\r\n')
    })
  }
  void boot()

  return {
    fit() {
      // 立即重算尺寸（非拖拽场景的兜底 fit）：与 ResizeObserver 同一路径——
      // propose → 方向感知调度（拉宽即刻贴合、收窄走静默防抖 + 推迟收缓冲）。
      if (disposed) return
      const proposed = safePropose()
      if (proposed === null) return
      routeProposedSize(proposed.cols, proposed.rows, false)
    },
    beginResize() {
      if (disposed) return
      // 拖拽开始（拖拽边界）：清掉挂起的静默定时器与待发尺寸——防止拖拽前
      // 已有 pending 发送在拖拽中段触发（拖拽期本应零 WINCH）；同时取消挂起
      // 的收窄延迟 resize（上一手势的推迟收缓冲不应落在新拖拽中段）。不再
      // 冻结几何：本地 fit/重排照常，同步由方向感知调度 + 静默防抖统一覆盖。
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer)
        resizeTimer = undefined
      }
      pendingSize = null
      cancelDeferredNarrow()
      narrowTarget = null
    },
    endResize() {
      if (disposed) return
      // 松手即同步点：清掉挂起的静默定时器与收窄延迟（拖拽期间可能刚重置过），
      // 包一层 rAF 等 React 把最终 inline width 刷进 DOM 后 propose + 按方向
      // 立即同步（绕开 300ms 等待，最终尺寸必达）：
      //   拉宽 → term.resize 先（缓冲立即贴到最终宽）→ 立即发 PTY；
      //   收窄 → 立即发 PTY（先窄）→ NARROW_DEFER_MS 后 term.resize（再收缓冲）。
      // sendResize 去重：尺寸未变则零发送。dispose 会取消该 rAF。
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer)
        resizeTimer = undefined
      }
      pendingSize = null
      cancelDeferredNarrow()
      if (endResizeRaf !== 0) cancelAnimationFrame(endResizeRaf)
      endResizeRaf = requestAnimationFrame(() => {
        endResizeRaf = 0
        if (disposed) return
        const proposed = safePropose()
        if (proposed === null) return
        routeProposedSize(proposed.cols, proposed.rows, true)
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      resolveCancelled?.()
      for (const id of pendingTimers) clearTimeout(id)
      pendingTimers.clear()
      // 兜底整屏重绘定时器已登记 pendingTimers（上面统一清除）；这里再显式
      // 清空挂起集合，保证 dispose 后不再残留对内部定时器的引用。
      for (const id of refreshFallbackTimers) clearTimeout(id)
      refreshFallbackTimers = []
      resizeObserver?.disconnect()
      layoutObserver?.disconnect()
      if (fitRaf !== 0) cancelAnimationFrame(fitRaf)
      if (endResizeRaf !== 0) cancelAnimationFrame(endResizeRaf)
      dataSubscription?.dispose()
      resizeSubscription?.dispose()
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
      resizeTimer = undefined
      pendingSize = null
      // 收窄方向的推迟 resize 一并取消（pendingTimers 已统一清除，这里清引用）
      cancelDeferredNarrow()
      narrowTarget = null
      try { ws?.close() } catch { /* already closed */ }
      term.dispose()
    },
  }
}