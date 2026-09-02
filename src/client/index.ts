/**
 * dsh-terminal 浏览器半入口。
 *
 *  - `shell.overlay` 注册 TerminalPanel（order 50；已有 occupant：
 *    ui-custom-preview 90 / ui-custom-usage 100）；
 *  - `sidebar.footer.action` 注册 ToggleButton（侧栏底部图标）；
 *  - window keydown 热键 Ctrl+` toggle 面板（ctx.effect 注册清理）。
 *
 * 槽位注册写法照抄 ui-custom（inject 面 hooks.visible → 组件 useVisible）。
 * 类型用本地最小接口声明，不 import 任何 @deepseek-ai/* 运行时值
 * （react 是平台模块表 external，可正常运行时 import）。
 */

import { panelStore } from './store.ts'
import { TerminalPanel } from './Panel.ts'
import { ToggleButton } from './ToggleButton.ts'
import './fonts.css'

/** slots 服务的最小本地面（与 ui-renderer registry 签名对齐）。 */
interface SlotsLike {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ClientContextLike {
  slots: SlotsLike
  effect(fn: () => unknown, name?: string): unknown
}

/** 硬依赖 slots 服务（web shell 核心能力，必在）。 */
export const inject = ['slots']

export function apply(ctx: ClientContextLike): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-terminal',
    order: 50,
    inject: () => ({ hooks: { visible: panelStore }, onClose: () => panelStore.close() }),
  }, TerminalPanel))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-terminal-toggle',
    order: 10,
    label: () => '终端',
    inject: () => ({ hooks: { visible: panelStore } }),
  }, ToggleButton))

  // Ctrl+` 热键 toggle 面板。
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.code === 'Backquote') {
        event.preventDefault()
        panelStore.toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, 'dsh-terminal: ctrl+` toggle')
}
