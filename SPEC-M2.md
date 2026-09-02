# dsh-terminal — M2 实施规范：多开标签 + 终端类型选择

在 M1 已验收的代码基上迭代。参照 ZCode 形态：面板头部为标签条（标签 = 一个独立终端会话），右端 `+` 新建（下拉可选 shell 类型），每标签带 `×`。**会话在面板隐藏后不销毁**，仅标签 `×` 或进程退出才结束。

## 现状（已验证，勿破坏）

- Host：`src/bridge.ts`（一 WS = 一会话；spawn/resize/kill 控制帧；心跳；清理纪律）、`src/index.ts`（registerUpgrade `/__dsh-terminal/ws`；prefix 路由 `/__dsh-terminal/assets` 伺服字体）、`src/shell.ts`（resolveShell 默认 shell）。
- Client：`src/client/terminal-session.ts`（createTerminalSession(container, callbacks)：字体等待 → 双 rAF 布局稳定 → fit → WS → spawn；100ms 节流 resize；beginResize/endResize 拖拽冻结+原子同步；dispose 幂等全清理；WebGL 默认关、localStorage `dsh-terminal.renderer='webgl'` 可开）、`src/client/Panel.ts`（同层停靠：data-dsh-terminal-dock + margin 让位；拖拽手柄；**当前面板隐藏即销毁会话**——M2 要改的就是这个）、`store.ts`（panelStore visible HostObservable）、`ToggleButton.ts`、热键 Ctrl+`。
- 构建：pnpm bundle（tsdown 双 face）；测试：node test/bridge.e2e.mjs（node-pty 注入）。

## Host 改动

1. `src/shell.ts` 新增 `detectShells(): Array<{ name: string; path: string; isDefault: boolean }>`：
   - 候选：`process.env.SHELL`（解析为绝对路径，existsSync 校验）、`/usr/bin/zsh`、`/bin/zsh`、`/bin/bash`、`/usr/bin/bash`、`/bin/sh`、`/usr/bin/fish`、`/bin/fish`、`/bin/dash`；按 PATH 再找 `pwsh`/`powershell`（POSIX 上没有就跳过；Windows 分支简单支持 pwsh/powershell/cmd 即可，本机 WSL 优先）。
   - 去重（按 realpath），name=basename；`isDefault` = 与 resolveShell() 结果同路径。
2. `src/index.ts` 新增 exact 路由 `GET /__dsh-terminal/shells` → JSON `detectShells()` 结果（`Content-Type: application/json`，短缓存即可）。
3. `src/bridge.ts`：spawn 帧接受可选 `shell: string`——**必须是 detectShells() 返回的 path 之一（allowlist 校验，否则 400 风格的 error 帧）**；合法则 argv=[path]，非法/缺省回落 resolveShell()。ready 帧的 shell 字段回显实际使用的 name。
4. 其他纪律不变（心跳/清理/去重语义）。

## Client 改动

1. 新模块 `src/client/sessions.ts` —— SessionManager：
   - `Map<id, { session: TerminalSession; container: HTMLDivElement; title: string; shellName: string; exited: boolean }>`；上限 8 个（达到则 + 禁用并 title 提示）。
   - 会话容器是**常驻 DOM**（挂在面板 body 内、非活跃时 `display:none`），面板隐藏不 dispose；仅 ×/进程退出才 dispose（dispose 走 session.dispose() + 容器移除）。
   - 活跃切换：切到某标签 = 显示其容器 + `fit()`（尺寸变了会自动发 resize）；隐藏其余。
   - 会话退出（onExit）：标签置灰/标记"已退出"，内容保留可查看，× 才移除。
2. `Panel.ts` 重构：
   - 头部改标签条：左侧标签列表（label = shellName，活跃高亮，× 关闭，中键也可关），右侧 `+` 按钮组：点 `+` 主体=默认 shell 新建；旁边小 caret 展开下拉（shells 列表来自 `GET /__dsh-terminal/shells`，面板每次打开时 fetch 一次并缓存）。
   - 面板 `×`（右上）= 隐藏面板，**会话保留**；再开时恢复活跃标签并 fit。
   - 全部会话关闭（无标签）时 body 显示空状态"无终端，点击 + 新建"。
   - 打开面板时若无会话则自动建一个默认 shell 会话（保持 M1 开箱体验）。
3. 样式：标签条/下拉/空状态全部走 Panel.module.css（或新增 module css），**全令牌化**（--dsw-* / var(--dsh-round-side,…)），active 标签底色用 `var(--dsw-alias-interactive-bg-active, …)` 类令牌（带缺省）。
4. 保持既有全部行为：同层停靠 margin 逻辑、拖拽冻结（begin/endResize 作用于当前活跃会话）、字体等待、热键、ToggleButton。
5. 注意：createTerminalSession 签名不变；多实例并存时各走各的 WS（一 WS 一会话不变）。

## 自验要求

- `pnpm exec tsc --noEmit` 零错；`pnpm bundle` 零报错。
- 扩展 `test/bridge.e2e.mjs`（或新增 test/shells.e2e.mjs）：spawn 带 `shell:'/bin/bash'` → `echo $0`/`$BASH_VERSION` 验证起的是 bash；spawn 带非法 shell 路径 → 收到 error 帧且不落 PTY；不带 shell → zsh（回归）。
- `node --test` 或直接跑这两个 e2e 脚本全绿。
- 注意 .mjs 测试里 import src/*.ts 受 Node 24 strip-only 限制（不用构造器参数属性等）。

## 边界

不改 SPEC.md/SPEC-M2.md、不改 profile、不改 harness、不动其他插件目录。工作目录 /home/lyy/workspace/DSH/Plugin/dsh-terminal/。

## 汇报

文件树变化、构建/测试输出、与规范的偏差、已知风险。
