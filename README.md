# dsh-terminal

DSH Web 内嵌终端插件，在主界面右侧打开真实终端，支持多标签、Shell 选择、拖拽调宽，以及通过 [dsh-ssh](https://github.com/reedflame40224/dsh-ssh) 连接远程工作区终端。

默认入口已迁移到 [dsh-std](https://github.com/Yan-Zero/dsh-std) 兼容实现，包含终端拉伸时的尺寸同步与换行修复。原始源码和提交历史完整保留。

## 功能

- **侧边停靠**：终端与主界面并排显示，面板宽度可拖拽调整。
- **多标签会话**：每个标签拥有独立 PTY，支持新建、切换和关闭，面板隐藏时保留会话。
- **Shell 选择**：检测本地可用 Shell，默认使用当前环境的 Shell，并校验启动目标。
- **终端显示**：内置 Nerd Font，支持 `TERM=xterm-256color`、真彩色与 Unicode 字符显示。
- **尺寸同步**：拖拽期间合并尺寸变化，结束时按拉宽或收窄方向同步 xterm 与 PTY。
- **远程联动**：安装兼容版 dsh-ssh 后，可为已连接的远程工作区打开终端。

打开入口为侧边栏终端图标，也支持快捷键 `` Ctrl+` ``。

## 兼容要求

| 项目 | 要求 |
| --- | --- |
| DSH 宿主 | 已验证 `0.1.2-rc.1`，此前也在 `0.1.2-alpha.2` 验证 |
| 社区适配器 | `@dsh-std/adapter-dsh@0.1.1-rc.2`，需在 Web profile 中启用 |
| Node.js | 24 或更高版本 |
| PTY | 宿主需提供可用的终端进程接口 |
| 安装方式 | 将 `node_modules` 外的源码仓库链接到 Web profile |

兼容层使用内部组件清单和 DSH 专用 UI 接口，尚不是 Community 0.15 跨宿主标准包。TypeScript 加载限制及宿主适配细节见 [兼容说明](COMPATIBILITY.md)。

## 安装与构建

```bash
git clone https://github.com/reedflame40224/dsh-terminal.git
cd dsh-terminal
pnpm install --frozen-lockfile
pnpm bundle
pnpm test
```

在 Web profile 的 `package.json` 中添加指向源码目录的依赖，例如 `"dsh-terminal": "link:/path/to/dsh-terminal"`，并在 `dsh.profile.bundles` 中启用 `@dsh-std/adapter-dsh` 和 `dsh-terminal`。保留原配置，完成 profile 依赖安装后重启 `dsh web`。

`pnpm bundle` 构建原始浏览器源码，再应用兼容转换，输出 `compat/terminal-dsh-bridge/lib/client.js`。仓库已跟踪该浏览器入口；字体资源位于 `assets/fonts/`。

## 拉伸换行修复

当前实现冻结拖拽过程中的中间尺寸，并合并最终调整：

- 拉宽时，先调整 xterm，再同步 PTY。
- 收窄时，先调整 PTY，等待 Shell 重绘后再让 xterm 重排。
- 新的尺寸变化或终端销毁会取消过期回调，避免旧尺寸覆盖新状态。

桥接层优先使用宿主原生的尺寸调整方法，并为旧版 PTY 句柄提供适配。Linux 下还会设置 `TERM=xterm-256color`，补偿旧宿主强制使用 `dumb` 的行为。

此前浏览器验收验证了长命令输入保留和 PTY 尺寸一致性，远程终端也完成了输入输出、尺寸调整和退出验收。

## 开发与测试

| 命令 | 用途 |
| --- | --- |
| `pnpm bundle` | 构建当前兼容版浏览器入口 |
| `pnpm test` | 运行 7 项兼容层生命周期与尺寸同步测试 |
| `pnpm bundle:legacy` | 仅构建原插件，不更新默认兼容入口 |
| `pnpm run watch` | 监听原源码并增量构建；兼容转换仍需另行执行 |
| `pnpm run test:e2e` | 运行保留的原插件测试 |

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `compat/terminal-std/` | 终端组件、WebSocket 桥接与生命周期管理 |
| `compat/terminal-dsh-bridge/` | DSH 接入、PTY 适配、浏览器入口与尺寸控制器 |
| `src/` | 原始插件及浏览器 TypeScript 源码 |
| `scripts/` | 兼容构建与测试脚本 |
| `assets/fonts/` | 终端字体 |

默认服务端入口为 `compat/terminal-dsh-bridge/index.mjs`。历史规格见 [SPEC.md](SPEC.md) 和 [SPEC-M2.md](SPEC-M2.md)，以当前兼容实现和测试结果为准。
