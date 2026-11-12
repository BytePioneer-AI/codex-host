# Proposal

## Why

独立 Web 保留了 DSH 右侧栏外壳，但未装配 DSH Web 原有的文件、文档预览、终端和浏览器插件及其后端服务，展开后只有「开始」页。目标是按 DSH Web 原样恢复这些能力，不新增功能。

## What Changes

- 装配 DSH Web 原有的四个右侧栏插件：文件树、文档预览、终端、浏览器，行为与 DSH Web 一致。
- 在 Web 服务进程内运行 DSH 原有的文件读取、终端控制和 Office 转换后端服务，并由 Web 网关转发对应请求。
- 新增一层对接：用 Web 已知的本地 Thread 提供 DSH 服务所需的会话身份与工作目录。

## Decisions

- **复用 DSH 后端，不重写。** 直接运行 DSH 的后端服务及其本地文件系统、子进程/PTY 依赖；codexhost 只写会话→工作目录对接与请求转发。放弃在 Host Runtime、共享契约或 Rust 层重新实现。
- **不新增功能。** 不新增设置项、开关、帮助文案、协议或存储；行为、限额与错误沿用 DSH Web。浏览器插件与 DSH Web 一样直接装配。
- **只接本地 Thread。** 取不到本地工作目录的 Thread（草稿、官方 Codex、远程）沿用 DSH 的「不可用」处理，不为此创建 Thread 或会话。

## Capabilities

### New Capabilities

- `web-right-sidebar`：独立 Web 右侧栏的文件、预览、终端、浏览器能力，及其与本地 Thread 的对接边界。

### Modified Capabilities

无。

## Impact

- `apps/web-ui`：引入四个 DSH 插件与所需 DSH 后端包（含依赖补丁、许可证），更新构建清单。
- `packages/web-server`：装配插件、在进程内运行 DSH 后端服务、提供会话→工作目录对接与请求转发。
- 发行包新增终端原生依赖与 Office 转换引擎资源。
- 更新 `docs/product/standalone-web.md`。
