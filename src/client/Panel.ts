/**
 * TerminalPanel —— shell.overlay 条目：右侧终端面板（同层停靠第四列卡片），M2 多标签。
 *
 * M2 核心语义：**面板隐藏 ≠ 会话销毁**。组件常驻挂载，唯一区别是根元素
 * `display:none`——可见性只由 visible 驱动 CSS 切换，会话容器（.sessions 内
 * 的常驻 DOM）与 WS 全部保留；隐藏时停靠属性/变量/样式标签照常还原（M1）。
 * 仅标签 ×（或进程退出后 ×）才结束会话（走 SessionManager.dispose）。
 *
 * 头部为标签条（ZCode 形态）：左侧标签列表（label=shell 名，活跃高亮，
 * ×/中键关闭），右侧 `+` 按钮组（主体=默认 shell 新建；caret 展开下拉，
 * 列表来自 `GET /__dsh-terminal/shells`，每次打开 fetch 一次并缓存），
 * 最右为面板 ×（隐藏面板）。无会话时 body 显示空状态「无终端，点击 + 新建」；
 * 打开面板时若无会话自动建一个默认 shell 会话（保持 M1 开箱体验）。
 *
 * 会话上限 MAX_SESSIONS：达到时新建入口禁用并 title 提示。
 * 拖拽边界同步（begin/endResize，静默期同步语义）作用于**当前活跃会话**（与
 * M1 冻结语义一致）：beginResize 清挂起静默定时器（拖拽期零 WINCH），
 * endResize 松手即静默点立即同步最终尺寸（去重，未变则零发送）。
 * 宽度 state 因组件常驻而在隐藏/重开间保留（M1 曾随卸载重置为默认宽度）。
 *
 * 样式全令牌化（--dsw-* / --dsh-round-side），严禁硬编码颜色。
 * 用 React.createElement 而非 JSX（免 JSX 变换配置，构建路径最短）。
 */

import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { sessionManager, MAX_SESSIONS } from './sessions.ts'
import css from './Panel.module.css'

/** InjectFace<{ hooks: { visible }, onClose }> 的最小本地声明。 */
export interface TerminalPanelProps {
  useVisible: <R>(selector: (value: boolean) => R) => R
  onClose: () => void
}

/** /__dsh-terminal/shells 响应条目。 */
export interface ShellOption {
  name: string
  path: string
  isDefault: boolean
}

const MIN_WIDTH_PX = 360
const DEFAULT_WIDTH_VW = 0.42
const MAX_WIDTH_VW = 0.9

const MAX_SESSIONS_TITLE = `最多支持 ${MAX_SESSIONS} 个终端会话`
const NEW_DEFAULT_TITLE = '新建终端（默认 shell）'

// —— 同层停靠（第四列卡片）——
// 溢出选择器无法写进 CSS Modules（类名会被编译改写），以 ctx 无关的 <style>
// 标签注入，由本组件 effect 持有并在隐藏/卸载时移除。
const DOCK_ATTR = 'data-dsh-terminal-dock'
const DOCK_STYLE_ID = 'dsh-terminal-dock-style'
const DOCK_GAP_PX = 8 // 对齐 dsh-rounded-panels 默认卡片缝隙 gap:8（其滑杆 0~24）
const DOCK_STYLE = [
  `html[data-dsh-terminal-dock="right"] [data-slot="root"] > div {`,
  `  margin-right: calc(var(--dsh-terminal-dock-width, 0px) + max(0px, var(--dsh-terminal-dock-gap, ${DOCK_GAP_PX}px) - var(--dsh-terminal-dock-pad, 0px)));`,
  `}`,
].join('\n')

/** 实测壳层行容器右内边距：rounded-panels 激活时框架自带 g px 缝隙，从让出量中减去以保持视觉缝隙恒为 DOCK_GAP_PX。 */
function measureFramePadRight(): number {
  const frame = document.querySelector('[data-slot="root"] > div')
  if (frame === null) return 0
  const pad = parseFloat(getComputedStyle(frame).paddingRight)
  return Number.isFinite(pad) && pad > 0 ? Math.round(pad) : 0
}

function clampWidth(px: number): number {
  return Math.min(Math.round(window.innerWidth * MAX_WIDTH_VW), Math.max(MIN_WIDTH_PX, Math.round(px)))
}

// —— shells 列表（M2）：模块级缓存 + 每次打开刷新（stale-while-revalidate）——
let shellsCache: ShellOption[] | null = null
let shellsLoading = false

/** 拉取可用 shell 列表并写缓存；失败保留旧缓存（无缓存则空列表，+ 默认 shell 不受影响）。 */
async function refreshShells(): Promise<void> {
  if (shellsLoading) return
  shellsLoading = true
  try {
    const res = await fetch('/__dsh-terminal/shells')
    if (!res.ok) throw new Error(`shells: HTTP ${res.status}`)
    const data = (await res.json()) as { shells?: ShellOption[] }
    shellsCache = Array.isArray(data.shells) ? (data.shells as ShellOption[]) : []
  } catch {
    /* 离线/宿主未就绪：本次打开用缓存或空列表 */
  } finally {
    shellsLoading = false
  }
}

// —— 远程目标（dsh-ssh 联动，M3）：同款 stale-while-revalidate；dsh-ssh 未挂载
//    （404/网络错）时静默为空，远程分组整体不显示，本插件独立可用。 ——
/** GET /__dsh-ssh/api/targets 响应条目（契约见 Plugin/dsh-ssh SPEC-M1.md G 节）。 */
export interface RemoteTarget {
  connectionId: string
  title: string
  kind: 'ssh' | 'win'
  online: boolean
  remotePath?: string
}

let targetsCache: RemoteTarget[] | null = null
let targetsLoading = false

/** 拉取远程目标列表并写缓存；失败保留旧缓存（从未成功则为 null=不渲染远程分组）。 */
async function refreshTargets(): Promise<void> {
  if (targetsLoading) return
  targetsLoading = true
  try {
    const res = await fetch('/__dsh-ssh/api/targets')
    if (!res.ok) throw new Error(`targets: HTTP ${res.status}`)
    const data = (await res.json()) as { ok?: boolean; items?: RemoteTarget[] }
    targetsCache = Array.isArray(data.items) ? data.items : []
  } catch {
    /* dsh-ssh 未挂载/离线：远程分组静默缺省 */
  } finally {
    targetsLoading = false
  }
}

export function TerminalPanel({ useVisible, onClose }: TerminalPanelProps) {
  const visible = useVisible((value) => value)
  useSyncExternalStore(sessionManager.subscribe, sessionManager.getVersion)
  const [width, setWidth] = useState(() => clampWidth(window.innerWidth * DEFAULT_WIDTH_VW))
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [shellOptions, setShellOptions] = useState<ShellOption[]>(shellsCache ?? [])
  const [remoteTargets, setRemoteTargets] = useState<RemoteTarget[]>(targetsCache ?? [])
  const sessionsRef = useRef<HTMLDivElement | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const plusGroupRef = useRef<HTMLDivElement | null>(null)
  const widthRef = useRef(width)
  widthRef.current = width

  // M2 核心：会话常驻宿主。组件挂载即登记 .sessions 容器宿主；仅组件整体
  // 卸载（而非面板隐藏）才清理全部会话。隐藏/显示由 visible 驱动 display 切换。
  useEffect(() => {
    sessionManager.setHost(sessionsRef.current)
    return () => {
      sessionManager.disposeAll()
      sessionManager.setHost(null)
    }
  }, [])

  // 每次打开：刷新 shells/远程目标（缓存兜底即时显示）+ 无会话则自动建默认 shell，
  // 有则恢复活跃标签并 fit（M2 打开面板语义）。
  useEffect(() => {
    if (!visible) return
    setShellOptions(shellsCache ?? [])
    void refreshShells().then(() => setShellOptions(shellsCache ?? []))
    setRemoteTargets(targetsCache ?? [])
    void refreshTargets().then(() => setRemoteTargets(targetsCache ?? []))
    if (sessionManager.getCount() === 0) sessionManager.create()
    else sessionManager.refitActive()
  }, [visible])

  // 停靠：可见时主表面让出右侧宽度；隐藏/卸载时属性、变量、样式标签全部还原。
  useEffect(() => {
    if (!visible) return
    const docEl = document.documentElement
    docEl.setAttribute(DOCK_ATTR, 'right')
    docEl.style.setProperty('--dsh-terminal-dock-pad', `${measureFramePadRight()}px`)
    if (document.getElementById(DOCK_STYLE_ID) === null) {
      const tag = document.createElement('style')
      tag.id = DOCK_STYLE_ID
      tag.textContent = DOCK_STYLE
      document.head.appendChild(tag)
    }
    return () => {
      docEl.removeAttribute(DOCK_ATTR)
      docEl.style.removeProperty('--dsh-terminal-dock-pad')
      docEl.style.removeProperty('--dsh-terminal-dock-width')
      document.getElementById(DOCK_STYLE_ID)?.remove()
    }
  }, [visible])

  // 宽度实时入 CSS 变量（拖拽调宽时主表面 margin 同步跟随）。
  useEffect(() => {
    if (!visible) return
    document.documentElement.style.setProperty('--dsh-terminal-dock-width', `${width}px`)
  }, [visible, width])

  // 下拉：点击外部（非下拉本体、非 + 组）关闭；Escape 亦关闭。
  useEffect(() => {
    if (!dropdownOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (dropdownRef.current?.contains(target) === true) return
      if (plusGroupRef.current?.contains(target) === true) return
      setDropdownOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDropdownOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [dropdownOpen])

  // 左缘拖拽手柄（作用于当前活跃会话）：rAF 合帧调宽；拖拽期活跃会话
  // beginResize() 清挂起静默定时器（静默防抖自然保证拖拽中零 WINCH），
  // 松手 endResize() 立即同步最终尺寸（静默点，去重未变则零发送）。
  // 会话在 mousedown 时捕获——拖拽中途切标签的边界场景也作用于同一会话。
  const onGripMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const draggedSession = sessionManager.getActiveSession()
    draggedSession?.beginResize()
    const startX = event.clientX
    const startWidth = widthRef.current
    let latestX = startX
    let raf = 0
    const applyWidth = (): void => {
      raf = 0
      setWidth(clampWidth(startWidth + (startX - latestX)))
    }
    const onMove = (move: MouseEvent): void => {
      latestX = move.clientX
      if (raf === 0) raf = requestAnimationFrame(applyWidth)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (raf !== 0) cancelAnimationFrame(raf)
      applyWidth()
      draggedSession?.endResize()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const entries = sessionManager.getEntries()
  const activeId = sessionManager.getActiveId()
  const atCap = entries.length >= MAX_SESSIONS

  const onNewDefault = (): void => { sessionManager.create() }
  const onNewShell = (option: ShellOption): void => {
    sessionManager.create({ shellPath: option.path, shellName: option.name })
    setDropdownOpen(false)
  }
  // 远程目标新建（dsh-ssh 联动）：spawn 帧带 target，标签先充 ssh·<title>。
  const onNewRemote = (target: RemoteTarget): void => {
    sessionManager.create({
      shellName: `${target.kind}·${target.title}`,
      target: {
        kind: target.kind,
        connectionId: target.connectionId,
        cwd: target.remotePath,
        shell: target.kind === 'win' ? 'powershell' : undefined,
      },
    })
    setDropdownOpen(false)
  }
  const onCloseTab = (event: ReactMouseEvent<HTMLButtonElement>, id: number): void => {
    event.stopPropagation() // 关标签不触发激活
    sessionManager.close(id)
  }
  const onTabAuxClick = (event: ReactMouseEvent<HTMLDivElement>, id: number): void => {
    if (event.button === 1) {
      event.preventDefault() // 禁中键自动滚动
      sessionManager.close(id)
    }
  }

  return createElement(
    'aside',
    {
      className: css.panel,
      // M2：隐藏 = display:none（会话常驻）；可见 = 正常布局（宽度实时在 CSS 变量）
      style: { width: `${width}px`, display: visible ? undefined : 'none' },
      role: 'dialog',
      'aria-label': '终端',
    },
    createElement('div', {
      className: css.grip,
      onMouseDown: onGripMouseDown,
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '调整终端宽度',
    }),
    createElement(
      'header',
      { className: css.tabbar },
      createElement(
        'div',
        { className: css.tabs, role: 'tablist', 'aria-label': '终端会话' },
        entries.map((entry) =>
          createElement('div', {
            key: entry.id,
            role: 'tab',
            'aria-selected': entry.id === activeId,
            className: `${css.tab} ${entry.id === activeId ? css.tabActive : ''} ${entry.exited ? css.tabExited : ''}`,
            title: entry.exited ? `${entry.label}（已退出）` : entry.label,
            onClick: () => sessionManager.activate(entry.id),
            onAuxClick: (event: ReactMouseEvent<HTMLDivElement>) => onTabAuxClick(event, entry.id),
          },
            createElement('span', { className: css.tabLabel }, entry.exited ? `${entry.label}（已退出）` : entry.label),
            createElement('button', {
              type: 'button',
              className: css.tabClose,
              'aria-label': `关闭 ${entry.label}`,
              onClick: (event: ReactMouseEvent<HTMLButtonElement>) => onCloseTab(event, entry.id),
            }, '×'),
          ),
        ),
      ),
      createElement(
        'div',
        { className: css.actions },
        createElement('div', { className: css.plusGroup, ref: plusGroupRef },
          createElement('button', {
            type: 'button',
            className: css.plusMain,
            'aria-label': NEW_DEFAULT_TITLE,
            disabled: atCap,
            title: atCap ? MAX_SESSIONS_TITLE : NEW_DEFAULT_TITLE,
            onClick: onNewDefault,
          }, '+'),
          createElement('button', {
            type: 'button',
            className: css.plusCaret,
            'aria-label': '选择终端类型',
            'aria-expanded': dropdownOpen,
            disabled: atCap,
            title: atCap ? MAX_SESSIONS_TITLE : '选择终端类型',
            onClick: () => setDropdownOpen((value) => !value),
          }, createElement('span', { className: css.caret }, '▾')),
        ),
        createElement('button', {
          type: 'button',
          className: css.panelClose,
          'aria-label': '隐藏终端面板',
          title: '隐藏终端面板',
          onClick: onClose,
        }, '×'),
      ),
      dropdownOpen
        ? createElement('div', { className: css.dropdown, ref: dropdownRef, role: 'menu' },
            shellOptions.length === 0
              ? createElement('div', { className: css.dropdownEmpty }, '未获取到 shell 列表')
              : shellOptions.map((option) =>
                  createElement('button', {
                    type: 'button',
                    key: option.path,
                    className: css.dropdownItem,
                    role: 'menuitem',
                    disabled: atCap,
                    title: atCap ? MAX_SESSIONS_TITLE : undefined,
                    onClick: () => onNewShell(option),
                  },
                    createElement('span', { className: css.dropdownName }, `${option.name}${option.isDefault ? '（默认）' : ''}`),
                    createElement('span', { className: css.dropdownPath }, option.path),
                  ),
                ),
            // 远程分组（dsh-ssh 联动）：有目标才渲染；离线项禁用。
            remoteTargets.length > 0
              ? createElement('div', { className: css.dropdownGroup, role: 'presentation' },
                  createElement('div', { className: css.dropdownGroupTitle }, '远程'),
                  remoteTargets.map((target) =>
                    createElement('button', {
                      type: 'button',
                      key: target.connectionId,
                      className: css.dropdownItem,
                      role: 'menuitem',
                      disabled: atCap || !target.online,
                      title: atCap ? MAX_SESSIONS_TITLE : (target.online ? undefined : `${target.title}（离线）`),
                      onClick: () => onNewRemote(target),
                    },
                      createElement('span', { className: css.dropdownName }, `${target.kind}·${target.title}`),
                      createElement('span', { className: css.dropdownPath }, target.remotePath ?? ''),
                    ),
                  ),
                )
              : null,
          )
        : null,
    ),
    createElement('div', { className: css.body },
      createElement('div', { className: css.sessions, ref: sessionsRef }),
      entries.length === 0
        ? createElement('div', { className: css.empty }, '无终端，点击 + 新建')
        : null,
    ),
  )
}