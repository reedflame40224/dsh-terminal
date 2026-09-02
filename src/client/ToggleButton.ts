/**
 * ToggleButton —— sidebar.footer.action 条目：侧栏底部的终端开关图标。
 *
 * ownerProps = { wide: boolean }（wide=false 时是 56px 窄轨，只显示图标）。
 * onClick → panelStore.toggle()。图标为内联 SVG（终端符 `>_` 风格）。
 */

import { createElement } from 'react'
import { panelStore } from './store.ts'
import css from './ToggleButton.module.css'

export interface ToggleButtonProps {
  wide: boolean
  useVisible: <R>(selector: (value: boolean) => R) => R
}

export function ToggleButton({ wide, useVisible }: ToggleButtonProps) {
  const visible = useVisible((value) => value)
  return createElement(
    'button',
    {
      type: 'button',
      className: `${css.button} ${wide ? css.wide : css.narrow} ${visible ? css.active : ''}`,
      title: '终端（Ctrl+`）',
      'aria-label': '终端',
      'aria-pressed': visible,
      onClick: () => panelStore.toggle(),
    },
    createElement(
      'svg',
      { className: css.icon, viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
      // `>` 提示符
      createElement('path', {
        d: 'M3 4.5 6.5 8 3 11.5',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
      // `_` 光标
      createElement('path', {
        d: 'M8.5 11.5h4.5',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
      }),
    ),
    wide ? createElement('span', { className: css.label }, '终端') : null,
  )
}
