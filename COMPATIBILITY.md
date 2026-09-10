# dsh-std 兼容说明

## 当前入口

插件默认从 `compat/terminal-dsh-bridge/index.mjs` 加载，组件实现在 `compat/terminal-std/` 中。原始 TypeScript 插件和浏览器源码仍保留在 `src/`，构建兼容版浏览器入口时继续使用这些源码。

## 运行要求

- 已验证宿主为 DSH `0.1.2-rc.1`，此前也在 `0.1.2-alpha.2` 完成测试。
- Web profile 需要启用 `@dsh-std/adapter-dsh@0.1.1-rc.2`。
- 使用 Node.js 24 或更高版本，并确保宿主 PTY 实现可用。
- 将源码仓库保留在 `node_modules` 外，通过本地目录链接安装。兼容层依赖 Node.js 内置 TypeScript 类型擦除，而该功能在 `node_modules` 内受到限制。
- 远程浏览器终端还需要安装并配置兼容版 dsh-ssh。

本实现采用内部组件清单和 DSH 专用 UI 接口，不属于 Community 0.15 跨宿主标准包。升级到其他宿主版本后，应重新验证加载、终端输入输出和尺寸调整。

## 构建与测试

```bash
pnpm install --frozen-lockfile
pnpm bundle
pnpm test
```

构建流程先编译原始浏览器源码，再运行 `scripts/build-compat-client.mjs` 应用兼容转换。已验证的浏览器入口纳入版本管理，字体继续使用 `assets/fonts/`。

`pnpm bundle:legacy` 只重建原插件，不会改变默认兼容入口。`pnpm run watch` 同样只监听原源码；更新兼容浏览器入口时需运行完整构建，或在原构建完成后执行兼容转换脚本。

## 尺寸同步机制

尺寸控制器在拖拽期间冻结中间尺寸，并按方向提交最终变化：拉宽时先更新 xterm，再更新 PTY；收窄时先更新 PTY，延迟让 Shell 完成重绘后再更新 xterm。过期回调会被取消，避免尺寸回退或销毁后继续调整。

桥接层优先使用宿主原生 resize 方法，必要时适配旧版 PTY 句柄。Linux 下通过命令环境设置 `TERM=xterm-256color`，补偿旧宿主的 `dumb` 设置。

## 验证范围

仓库测试覆盖能力协商、路由与生命周期清理、拖拽尺寸合并、过期回调取消、Windows Shell 检测和内部 PTY resize 转发。此前实机验收还验证了浏览器中长命令输入保留、PTY 尺寸同步，以及 SSH 远程终端的输入输出、调整尺寸和退出。

测试通过不代表已在所有操作系统和 Shell 组合上完成实机验收。用户 profile、终端历史、密码和真实连接记录均不应提交到本仓库。

Windows 原生隔离实验使用 Node.js 24 和 DSH `0.1.2-rc.1`，9 项兼容测试通过。浏览器面板加载正常，真实 PowerShell 执行命令成功，ConPTY 从 80x24 调整到 103x37 后通过 `[Console]::WindowWidth` / `WindowHeight` 回读确认，终端退出事件正常。Windows 远程 SSH 实机验收因现有目标连接超时尚未完成。
