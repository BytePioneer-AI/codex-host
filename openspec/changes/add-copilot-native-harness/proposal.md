# Proposal

## Why

codexhost 尚未提供 GitHub Copilot Harness。用户需要沿用本机 Copilot 的登录、工具和原生会话，在 Desktop 中持续对话、恢复历史并接收委派；官方原生接口已提供接入基础，但历史边界、权限与生命周期仍需实测确认。

## What Changes

- 新增 `copilot` 独立预装插件，提供检查、多轮流式执行、工具与文件内容、审批、提问、取消、只读历史、持久恢复和资源释放。
- 按最新 Harness skill 完成 P0 与 P1：原生 Model/Thinking/权限控制、无人值守意图处理、精确 Fork、回滚最后一轮、自主输出、会话用量及接收委派。原生条件项以探测证据决定支持范围，必做能力未通过时不交付普通 Thread。
- 通过公共插件目录提供 Desktop 展示、安装指引、版本检查与更新，完成隔离加载、发行和真实 UI 验收。
- 跨目录 Fork、完整 Subagent 能力、请求级计量、向下委派、一键安装、历史导入与全局统计保留为 P2。

- 按用户追加要求接入原生账号剩余额度与会话 AI Credits，通过公共账号/用量契约展示，不推算美元费用。

## Decisions

- 使用官方 Copilot SDK 连接已安装的本地 CLI；保留原生 Agent Loop、工具、配置和认证。ACP 不作为本次主路径或自动回退路径。
- 复用目标 Host 上原生登录，遵循原生环境变量优先级；不建立第二套凭据存储，不承诺跨 OS 用户或远程机器共享登录。
- 历史与派生操作以原生事实为准；先验证稳定身份、精确前缀和取消终态，再声明支持，不通过重发可见消息模拟历史。
- 复用公共 Harness 契约和目录驱动 Desktop。发现表达缺口时记录并修订通用设计，不增加 Copilot 专用 Host/Renderer 分支。

## Capabilities

### New Capabilities

- `copilot-harness-session`：Copilot 的本地认证、持续会话、交互、配置、历史派生和产品接入行为。

### Modified Capabilities

无。沿用现有 Harness 会话、历史、权限、用量、路由和委派契约；本提案不改变其公共语义。

## Impact

主要实现位于 `packages/adapters/copilot/`，以已有 `CAPABILITIES.md` 的 39 行为交付清单。新增插件私有 SDK 依赖；预装阶段调整构建引用、lockfile、发行清单、加载与发行测试、Harness 文档和索引。Host 核心不静态依赖插件或 SDK，官方 Codex Thread 路径保持独立。
