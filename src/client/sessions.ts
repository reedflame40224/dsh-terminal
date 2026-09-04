/**
 * SessionManager —— 多终端会话的常驻容器管理（M2）。
 *
 * 核心语义变化（对照 M1）：面板隐藏不再销毁会话。会话容器是面板 body 内
 * 「常驻 DOM」——切换标签只做 display:none/block（.sessionContainer /
 * .sessionActive 类切换），面板本身隐藏时整棵子树随面板 display:none 而不可见
 * 但仍在 DOM 中；仅标签 ×（或进程退出后由用户 ×）才 session.dispose() +
 * 容器移除。上限 MAX_SESSIONS 个（达到时 Panel 禁用新建入口并 title 提示）。
 *
 * 活跃切换：activate(id) 显示目标容器并隐藏其余，再对活跃会话 fit()——
 * 尺寸变化走会话内 onResize → 100ms 节流链路自动发 resize（spawn 前的等待期
 * 由会话内 boot 的布局稳定逻辑保证，与 M1 一致）。
 *
 * 会话退出（onExit）：条目标 exited（标签置灰显示「已退出」），内容保留可
 * 查看，× 才移除。非活跃会话关闭不触碰显示状态；活跃会话关闭后自动落到
 * 相邻标签（先右后左，无则空态）。
 *
 * 与 React 的关系：本模块是模块级单例（同 panelStore 模式），Panel 组件通过
 * useSyncExternalStore(getVersion) 订阅只读视图（getEntries/getActiveId）。
 * 容器由本模块命令式创建/移除（React 不 reconcile .sessions 子树，避免干扰
 * xterm 的 open/fit）。
 */

import { createTerminalSession } from './terminal-session.ts'
import type { TerminalSession } from './terminal-session.ts'
import css from './Panel.module.css'

/** 同时存在的会话上限（达到则新建入口禁用）。 */
export const MAX_SESSIONS = 8

/** 面板读视图用到的会话摘要（无活对象引用，可安全跨 React 渲染）。 */
export interface SessionEntry {
  id: number
  /** 标签文案：ready 后为实际 shell 名；ready 前为请求 shell 名或「连接中…」。 */
  label: string
  /** 进程是否已退出（标签置灰、内容保留，× 才移除）。 */
  exited: boolean
}

export interface CreateSessionOptions {
  /** 请求的 shell 绝对路径（来自 /__dsh-terminal/shells allowlist）；缺省回落默认 shell。 */
  shellPath?: string
  /** 请求的 shell 名（下拉项给出），ready 前先充作标签文案。 */
  shellName?: string
  /** 远程 target（dsh-ssh 联动）：spawn 帧带 target，与 shellPath 互斥。 */
  target?: { kind: 'ssh' | 'win'; connectionId: string; cwd?: string; shell?: 'powershell' | 'cmd' }
}

interface SessionRecord {
  id: number
  session: TerminalSession
  container: HTMLDivElement
  label: string
  exited: boolean
}

const records = new Map<number, SessionRecord>()
let nextId = 1
let activeId: number | null = null
/** .sessions 容器宿主（面板 body 内，常驻；面板隐藏不卸载）。 */
let host: HTMLElement | null = null
/** host 未就绪时暂存的最近一次新建请求（setHost 时 flush；联动事件先于面板首挂载的场景）。 */
let pendingCreate: CreateSessionOptions | undefined
/** 变更版本号：任何增删/激活/退出/改名都 +1，驱动 useSyncExternalStore 重渲染。 */
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

function setHost(element: HTMLElement | null): void {
  host = element
  // flush 暂存的新建请求（面板首次挂载晚于 dsh-ssh 联动事件的时序兜底）。
  if (host !== null && pendingCreate !== undefined) {
    const options = pendingCreate
    pendingCreate = undefined
    create(options)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getVersion(): number {
  return version
}

function getCount(): number {
  return records.size
}

function getEntries(): SessionEntry[] {
  return [...records.values()].map((record) => ({ id: record.id, label: record.label, exited: record.exited }))
}

function getActiveId(): number | null {
  return activeId
}

function getActiveSession(): TerminalSession | null {
  const record = activeId !== null ? records.get(activeId) : undefined
  return record?.session ?? null
}

/** 新建会话：容器入常驻 DOM → createTerminalSession（带可选 shell/target）→ 激活新标签。 */
function create(options?: CreateSessionOptions): number | null {
  if (records.size >= MAX_SESSIONS) return null
  if (host === null) {
    // 面板尚未首挂载：暂存请求，setHost 时 flush（只留最近一次）。
    pendingCreate = options ?? {}
    return null
  }
  const id = nextId++
  const container = document.createElement('div')
  container.className = css.sessionContainer
  host.appendChild(container)
  const session = createTerminalSession(container, {
    onReady: ({ shell }) => {
      const record = records.get(id)
      if (record === undefined) return
      if (shell.length > 0) record.label = shell
      notify()
    },
    onExit: () => {
      const record = records.get(id)
      if (record === undefined) return
      record.exited = true
      notify()
    },
  }, { shell: options?.shellPath, target: options?.target })
  records.set(id, { id, session, container, label: options?.shellName ?? '连接中…', exited: false })
  activate(id) // 内部 notify
  return id
}

/** 激活标签：显示其容器、隐藏其余、fit()（尺寸变化自动发 resize）。 */
function activate(id: number): void {
  const record = records.get(id)
  if (record === undefined || activeId === id) return
  activeId = id
  for (const [rid, rec] of records) rec.container.classList.toggle(css.sessionActive, rid === id)
  notify()
  record.session.fit()
}

/** 关闭标签（×/中键）：dispose 会话 + 移除容器；活跃者落到相邻标签（先右后左）。 */
function close(id: number): void {
  const record = records.get(id)
  if (record === undefined) return
  const order = [...records.keys()]
  const index = order.indexOf(id)
  const fallback = order[index + 1] ?? order[index - 1] ?? null
  record.session.dispose()
  record.container.remove()
  records.delete(id)
  if (activeId === id) {
    activeId = null
    if (fallback !== null) activate(fallback)
    else notify()
  } else {
    notify()
  }
}

/** 面板每次打开时恢复活跃标签并 fit（尺寸早已就绪时零发送，sendResize 去重）。 */
function refitActive(): void {
  const record = activeId !== null ? records.get(activeId) : undefined
  record?.session.fit()
}

/** 全量清理（仅面板组件整体卸载时调用；隐藏 ≠ 卸载，不触达）。 */
function disposeAll(): void {
  for (const record of [...records.values()]) {
    record.session.dispose()
    record.container.remove()
  }
  records.clear()
  activeId = null
  notify()
}

export const sessionManager = {
  setHost,
  subscribe,
  getVersion,
  getCount,
  getEntries,
  getActiveId,
  getActiveSession,
  create,
  activate,
  close,
  refitActive,
  disposeAll,
}