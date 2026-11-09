# Proposal

## Why

做设计时，agent 写出 HTML 原型（例如 `.spec/mockups/`），用户却要自己找到文件、在浏览器里打开，每次修改后还要手动刷新。设计讨论需要预览贴着对话、随修改实时更新；这是有些用户为设计任务单独换用其他桌面客户端的主要原因，代价是设计会话与执行会话分家，查看代码和管理父子会话都不方便。codexhost 已能在 Codex 内置浏览器打开本地页面，只差把它开放给 agent。

## What Changes

- 新增 `codexhost preview open <path>`：Host 在 loopback 随机端口上服务该文件所在目录，并在 Codex 内置浏览器的后台标签打开，挂在当前可见的本地任务下并切到前台。返回预览标识与 URL。
- 被服务目录中的文件变化后，已打开的预览页自动刷新。
- 新增 `preview list`、`preview show <id>`、`preview close <id>`。Thread 归档或 Runtime 退出时，相关预览随之关闭。
- 内置浏览器不可用、没有可见的本地任务，或在受管远程 Host 上时，返回明确原因与文件路径；本机可用时改为在系统浏览器打开并说明。
- 任何 Harness 的 Thread 都可以使用，命令随委派 CLI 一同提供并写入帮助文档。

## Decisions

- **复用现有的本地页面能力，不新造 UI。** 内置浏览器已在 Codex 中，Host 已有经 Desktop Controller 打开 loopback 页面的通道（ZCode 验证页在用）。本提案只把它开放给 Thread，不改 Renderer。
- **只服务调用方工作目录内的文件，且只读。** 预览服务器只响应 GET，根目录限定为目标文件所在目录，不能越出调用方 Thread 的工作目录；拒绝路径穿越和符号链接越界。
- **刷新脚本只注入预览服务器返回的 HTML。** 不向 Codex 聊天页注入任何脚本，满足现有本地页面接口的约束。
- **不做 claude.ai Artifacts 的分享、评论与版本历史。** 目标是“边聊边看”，分享仍走现有方式。
- 放弃的方案：把预览嵌入聊天消息。需要改 Renderer 和官方消息结构，维护成本高，且受 Desktop 版本影响更大。

## Capabilities

### New Capabilities

- `local-design-preview`：Thread 在 Codex 内置浏览器中打开本地 HTML 预览、自动刷新和生命周期管理。

### Modified Capabilities

无。

## Impact

`packages/host-runtime`（预览服务器、文件监听、CLI 子命令和控制路由），复用 `packages/desktop-control` 已有的本地页面通道。帮助文本与委派 Skill 增加 preview 用法。不涉及持久化；预览只在 Runtime 生命周期内存在。
