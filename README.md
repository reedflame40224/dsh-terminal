# dsh-terminal

默认入口现为已迁移的 dsh-std 兼容版本，已在 DSH `0.1.2-rc.1` 验证，并包含终端拉伸换行修复。安装前请阅读 [兼容层说明](COMPATIBILITY.md)，其中列出了适配器、构建与测试要求。下文保留原插件的功能说明与历史用法。

DSH Web GUI 内嵌终端插件：在主表面右侧（同层第四列）打开真实终端，支持多开标签与 shell 类型选择。

## 功能

- **同层停靠**：终端面板与侧边栏/主表面同层并排（不遮挡内容），宽度可拖拽，令牌化样式天然兼容 [dsh-client-ui-custom](https://github.com/Yoli-mi/dsh-client-ui-custom) 与 dsh-rounded-panels 美化插件。
- **多开标签**：头部标签条，每标签一个独立 PTY 会话；`+` 新建（caret 下拉选择 shell 类型），`×`/中键关闭，上限 8；面板隐藏会话保活。
- **当前环境默认 shell**：本机 `$SHELL`（WSL=zsh，含 p10k 美化渲染）；`GET /__dsh-terminal/shells` 列出检测到的可用 shell，spawn 参数走 host 侧 allowlist 校验。
- **终端美化兼容**：内嵌 Nerd Font（AtkynsonMono NFM，OFL）、`TERM=xterm-256color`、`COLORTERM=truecolor`、unicode11、WebGL 可选（localStorage `dsh-terminal.renderer='webgl'`，默认 canvas）。
- **精细的 resize 体验**：拖拽/窗口拉缩期间 xterm 本地重排、几何安静 ~300ms 后才同步 PTY（一次手势至多一次 SIGWINCH）；方向感知时序——拉宽缓冲先行、收窄 PTY 先行，p10k 重绘零残影。
- 入口：侧边栏底部 `>_` 图标或全局热键 `` Ctrl+` ``。

## 架构

```
浏览器 (client)                      DSH Host (host)
xterm.js 面板 (shell.overlay)         WsTerminalBridge（cordis 无关纯 Node）
  └ sessions.ts 会话管理     WS       ├ ctx.subprocess.spawnTerminal（node-pty）
  └ 方向感知尺寸调度        ◄──────►  ├ ctx.webServer：WS 升级路由 + 字体静态路由
sidebar.footer.action 图标            └ detectShells / resolveShell
```

- 一条 WS = 一个终端会话；二进制帧传原始字节，JSON 文本帧传 spawn/resize/kill 与 ready/exit/error。
- 依赖 harness 两处能力（当前以未提交补丁存在于本地 harness fork）：
  1. `SubprocessTerminalHandle.resize(cols, rows)`（packages/subprocess/*/types.ts、subprocess-local、e2b）；
  2. spawnTerminal 尊重调用方 `env.TERM`（subprocess-local `name: spec.env?.TERM ?? 'dumb'`）。

## 开发

```bash
pnpm install        # pnpm 11：node-pty 构建白名单在 pnpm-workspace.yaml 的 allowBuilds
pnpm bundle         # 双 face 构建 → lib/index.js (ESM host) + lib/client.js (CJS browser)
pnpm run watch      # 增量构建
pnpm run test:e2e   # 离线 e2e：WS 桥全链路 + shells 不变量（node-pty 注入）
```

挂载（web profile）：`~/.dsh/profiles/web/package.json` 加 `link:<本目录>` 依赖并在 `dsh.profile.bundles` 追加 `dsh-terminal`，`pnpm install` 后重启 `dsh web`。在线验收脚本在 `test/online/`（需插件在线运行）。

## 规格文档

- `SPEC.md` — M1 实施规范（WS 协议、槽位契约、样式约束）
- `SPEC-M2.md` — M2 实施规范（多开标签、类型选择、会话保活）
