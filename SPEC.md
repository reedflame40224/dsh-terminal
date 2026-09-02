# dsh-terminal — M1 实施规范（子 agent 必读）

目标：DSH Web GUI 内嵌终端插件 M1。右侧固定面板、单标签、渲染当前环境默认 shell（本机 WSL=zsh，含 p10k 美化），拖拽调宽后 PTY resize 同步、渲染不乱屏。

验收标准（主 agent 执行）：
1. 离线 e2e：`node test/bridge.e2e.mjs` 通过（WS 桥 + 真 PTY，spawn→输出生效→resize 后 `stty size` 变化→exit）。
2. 挂载后在线验证：`curl localhost:3080/__dsh-terminal/assets/...` 200；WS 脚本对 `ws://127.0.0.1:3080/__dsh-terminal/ws` 完成 spawn/echo/resize/exit 全链路。
3. 浏览器肉眼：侧边栏底部出现终端图标 → 点击右侧滑出面板 → p10k 提示符字形正常 → 输入命令回显正常 → 拖宽不花屏。

## 已验证事实（不要重新发明、不要怀疑，直接按此实现）

### 运行时服务（Host 半，cordis ctx）
- `ctx.get('subprocess')` → `{ spawnTerminal(spec): Promise<Handle> }`。
  - spec: `{ argv: string[], cwd: string, env?: Record<string,string>, rows: number, cols: number, graceMs: number }`。
  - Handle: `{ pid, output: Readable(Node流), done: Promise<{exitCode,signal}>, write(data: string): Promise<void>, terminate(): Promise<void>, resize(cols,rows) }`。
  - ⚠️ `resize` 是并行子 agent 正在给 harness 补的方法；写代码时假设它存在（调用处 try/catch 容错）。
- `ctx.get('webServer')` →
  - `registerUpgrade({ path, handler(req: IncomingMessage, socket: Duplex, head: Buffer) }): () => void` —— 精确路径 WS 升级路由。
  - `register({ kind: 'prefix'|'exact', path, handler(req,res) }): () => void` —— HTTP 路由（用于伺服字体静态文件）。
- 服务可能未加载：用 `ctx.get(name)` 并判 undefined，缺失时 throw 带清晰信息的 Error（不要静默）。
- Host 插件形态：`export function apply(ctx, config) {}`（参照 /home/lyy/workspace/DSH/DSH_BP/packages/ui-custom/src/index.ts）。**不要 import 任何 @deepseek-ai/* 运行时值**（链接挂载的插件解析不到），服务类型在本地用最小结构接口声明；type-only import 可以用。

### WS 桥实现要点
- harness 自己的 gateway 用 npm 包 `ws`（`WebSocketServer({ noServer: true })` + `server.handleUpgrade(req, socket, head, cb)`，见 deepseek-harness/packages/api/gateway/src/stream-server.ts）。**我们也用 `ws`**，列为 dsh-terminal 的 dependency（插件目录自己 pnpm install，Node 从插件目录解析）。
- 协议（一条 WS = 一个终端会话）：
  - C→S 文本帧 JSON：`{t:'spawn',cols,rows,cwd?}` / `{t:'resize',cols,rows}` / `{t:'kill'}`
  - C→S 二进制帧：终端输入原始字节（收到后 `handle.write(str)`）。
  - S→C 二进制帧：PTY 输出原始字节（`handle.output` 管道数据）。
  - S→C 文本帧 JSON：`{t:'ready',pid,shell}` / `{t:'exit',exitCode,signal}` / `{t:'error',message}`。
  - spawn 前收到的二进制帧丢弃；WS 关闭必须 `terminate()` PTY；30s ping 心跳，失活清理。
- **桥必须是与 cordis 无关的纯 Node 类** `WsTerminalBridge`（构造注入 `{ spawnTerminal, resolveShell }`），插件 apply 只是薄壳——这样离线 e2e 不依赖 dsh 进程。
- 默认 shell 解析 `resolveShell()`：`process.env.SHELL` → 解析 `/etc/passwd` 当前用户行第 7 字段 → `/bin/sh`。返回 `{ argv:[shell], name }`。spawn env 追加：`TERM=xterm-256color`、`COLORTERM=truecolor`。cwd 缺省 `process.cwd()`。

### Client 半（浏览器，React 18）
- 槽位注册写法（照抄 ui-custom，见 DSH_BP/packages/ui-custom/src/client/index.ts 第 388 行附近）：
  ```ts
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-terminal', order: 50,
    inject: (): TerminalPanelInjected => ({ hooks: { visible: panelStore }, onClose: () => panelStore.close() }),
  }, TerminalPanel))
  ```
  `shell.overlay` 层本身 click-through，**面板根元素必须 `pointer-events: auto`**。已有 occupant：ui-custom-preview(90)/ui-custom-usage(100)，我们 order 50。
- 侧边栏图标：`ctx.slots.inject('sidebar.footer.action', ...)`，注册 `{ name:'sidebar.footer.action', id:'dsh-terminal-toggle', order: 10, label: () => '终端' }, ToggleButton`。ownerProps = `{ wide: boolean }`（wide=false 时是 56px 窄轨，只显示图标）。onClick → `panelStore.toggle()`。图标用内联 SVG（终端符 `>_` 风格）。
- 可见性 store 照抄 ui-custom usage-overlay.ts 的 HostObservable 模式（getSnapshot/subscribe/toggle/close）。
- 热键：window keydown 监听 `Ctrl+反引号`（`e.ctrlKey && e.code==='Backquote'`），toggle 面板，`ctx.effect` 注册清理。
- xterm（dependencies 安装，全部内联进 bundle）：`@xterm/xterm@^6` + `@xterm/addon-fit` + `@xterm/addon-unicode11` + `@xterm/addon-web-links`（+ `@xterm/addon-webgl` 可选，try/catch 失败回落 canvas）。
  - `new Terminal({ allowTransparency: true, theme: { background: '#00000000' }, fontFamily: '"AtkynsonMono NFM","MesloLGS NF",monospace', fontSize: 13, cursorBlink: true })`；`unicode11` 加载后 `term.unicode.activeVersion = '11'`。
  - 时序：`term.open(container)` → `fitAddon.fit()` → 读 `term.cols/rows` → WS 连接 → 发 spawn → onData 二进制上行、onmessage 二进制 `term.write` → ResizeObserver/拖拽后 `fit()` + 发 `{t:'resize',cols,rows}`。
  - xterm.css 必须进 bundle：参考 ui-custom tsdown.config.ts 的 cssModuleLoader 思路，给 `.css`（非 module）也做一个"读文件文本 → 注入 `<style data-plugin>`"的虚拟模块插件。
- 面板 React 组件：固定右侧抽屉（`position: fixed; right:0; top:0; bottom:0`，宽度默认 42vw、min 360px，左缘 8px 拖拽手柄 mousedown/mousemove 调宽），顶部标题栏（"终端" + shell 名 + 关闭×）。隐藏时返回 null。
- **样式全部令牌化**（兼容 ui-custom/rounded-panels 的硬要求）：
  - 背景 `var(--dsw-alias-bg-layer-1)`、边框 `var(--dsw-alias-border-l1)`、标题栏文字 `var(--dsw-alias-label-primary)`、次要文字 `var(--dsw-alias-label-secondary)`。
  - 圆角 `var(--dsh-round-side, 14px)`（rounded-panels 提供的变量，缺省 14px）。
  - 严禁硬编码颜色值（终端 ANSI 调色板除外，M1 用 xterm 默认）。
  - CSS Modules 编译照抄 ui-custom 的 lightningcss 方案。

### 字体（p10k 字形）
- 系统已有 Nerd Font：`/usr/share/fonts/OTF/AtkynsonMonoNerdFontMono-Regular.otf`（OFL 许可）。**复制**（不要移动）到 `assets/fonts/`，host 半用 `webServer.register({kind:'prefix', path:'/__dsh-terminal/assets/', ...})` 伺服（读文件流，Content-Type `font/otf`，带强缓存头）。
- client CSS `@font-face { font-family:'AtkynsonMono NFM'; src:url('/__dsh-terminal/assets/fonts/AtkynsonMonoNerdFontMono-Regular.otf'); font-display:swap; }`。

### 打包与构建（照抄 DSH_BP/packages/ui-custom）
- `tsdown.config.ts`：复制 ui-custom 的并改：`ID = 'dsh-terminal'`；node 半 external 加 `ws`；client external 保持 PLATFORM_MODULES（react、cordis、dsh-client-runtime/client 等，见 ui-custom），xterm 相关**不要** external（内联）。banner/footer 的 `__ModuleLoader__.load({id})` 机制原样保留，id 必须等于 cordis.patch.yml 里的 name。
- `package.json`：`name: 'dsh-terminal'`，`type:'module'`，`main:'lib/index.js'`，exports `.`/`./client`/`./package.json`；`dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }`；scripts `bundle: tsdown`、`watch: tsdown --watch`。
- `cordis.patch.yml`：`- insert:` 一行 `{ id: dsh-terminal, name: dsh-terminal }`。
- 依赖安装：插件目录独立 `pnpm install`（ws / @xterm/* / react 类型 / tsdown / lightningcss / typescript；`node-pty` 仅 devDependency 供离线 e2e 注入真实 spawnTerminal）。
- 构建产物：`pnpm bundle` → `lib/index.js`（ESM node）+ `lib/client.js`（CJS browser 带 loader 包装）。

### 离线 e2e（test/bridge.e2e.mjs，纯 node，必须过）
1. 起 `http.createServer` + `new WsTerminalBridge({ spawnTerminal: 用 node-pty 实现的适配器, resolveShell })`，server.on('upgrade') 转发。
2. `ws` 客户端连接：发 spawn(80,24) → 等 ready → 收集输出 2s 应含 zsh 提示符字节；发 `echo $ZSH_VERSION\n` → 输出含版本号；发 resize(100,40) → 发 `stty size\n` → 输出含 `40 100`；发 `exit\n` → 收 exit 帧。
3. 进程退出码 0/非 0 表成败，超时 15s 兜底。

## 边界
- 不许修改 deepseek-harness（harness 补丁归另一个子 agent）。
- 不许修改 ~/.dsh/profiles/web/（挂载归主 agent）。
- 不许动 Plugin/ 下其他插件目录。
- 工作根目录：`/home/lyy/workspace/DSH/Plugin/dsh-terminal/`（自建）。

## 完成定义
`pnpm install && pnpm bundle` 零报错；`node test/bridge.e2e.mjs` 通过；目录含 package.json/cordis.patch.yml/tsdown.config.ts/src/index.ts/src/client//assets/fonts/test/；汇报：文件清单 + 构建输出 + e2e 输出 + 已知风险。
