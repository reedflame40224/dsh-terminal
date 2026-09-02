/**
 * 终端面板可见性 store：模块级 HostObservable（照抄 ui-custom usage-overlay.ts
 * 模式），让侧边栏按钮与 Ctrl+` 热键能从任何地方 toggle 面板；
 * shell.overlay 条目订阅它，隐藏时渲染 null。
 */

interface PanelState {
  visible: boolean
  listeners: Set<() => void>
}

const state: PanelState = { visible: false, listeners: new Set() }

const notify = (): void => {
  for (const listener of [...state.listeners]) listener()
}

/** HostObservable<boolean> face the overlay entry binds. */
export const panelStore = {
  /** @returns whether the terminal panel is currently shown. */
  getSnapshot: (): boolean => state.visible,
  /** Subscribe to visibility changes. */
  subscribe: (listener: () => void): (() => void) => {
    state.listeners.add(listener)
    return () => state.listeners.delete(listener)
  },
  /** Toggle the panel (sidebar button / Ctrl+` shortcut). */
  toggle: (): void => {
    state.visible = !state.visible
    notify()
  },
  /** Hide the panel (close button). */
  close: (): void => {
    if (!state.visible) return
    state.visible = false
    notify()
  },
}
