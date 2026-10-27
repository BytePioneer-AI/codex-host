# Proposal

## Why

官方定时任务创建会被同一 Host 残留的外部 Harness 选择影响，用户未选择 Harness 也可能创建出 Pi Thread。需要隔离官方入口，并为明确需要外部 Harness 的用户提供一个复用 Desktop 调度的独立入口。

## What Changes

- 官方定时任务创建始终走官方 Codex，不继承普通聊天或 codexhost 页面中的外部 Harness 选择。
- 在 Desktop 内现有 codexhost 设置页面框架新增“定时任务”页，提供任务内容、Harness、Model、重复时间，以及高级设置中的可选工作目录。
- 创建时生成一个固定的外部 Thread 并绑定日程；工作目录留空时复用 Desktop 的默认工作区分配行为。
- Desktop 负责保存日程和触发后续执行；自有页面统一列出本地 Codex 与外部 Harness 固定聊天任务，标明 Harness，支持打开历史聊天、修改名称/正文/时间、暂停/恢复和删除日程。

## Decisions

- 第一版仅支持本地、固定聊天的周期任务。Harness 与工作目录属于目标 Thread；Model 初始选择保存在 Thread 配置中，后续跟随该聊天。
- 复用 Desktop 内部任务服务，不增加调度器、日程数据库或 Harness 专用定时协议。接口不可用时明确禁用创建，不降级为系统定时器。
- 使用现有设置页和 Harness 模型目录；不新增独立 Web 控制台入口、任务管理后台、既有聊天选择器、每次新建聊天模式、Worktree、云端/远程调度或高级调度策略。
- 两处界面使用同一份 Desktop 日程，不按创建入口隐藏本地固定聊天任务。自有页面创建外部 Harness 任务，官方入口创建 Codex 任务；统一列表不改变这一分工。管理不复制聊天历史，不更换任务绑定的 Harness/目录；Model 通过既有聊天配置调整。删除日程保留聊天和文件，不中断当前 Turn。

## Capabilities

### New Capabilities

- `harness-fixed-thread-schedules`: 在自有页面配置外部 Harness 的固定聊天，并复用 Desktop 的本地周期调度。

### Modified Capabilities

- `versioned-renderer-agent-routing`: 明确官方定时任务创建不受外部 Harness 选择影响，并隔离显式外部任务创建请求。

## Impact

涉及 `renderer-extension` 的自有设置页与路由、`desktop-control` 的版本化 Desktop 接入，以及必要的 `shared-contracts` 和 `host-runtime` 固定会话操作组合。复用现有插件、模型目录与 Thread 持久化；不新增依赖、Rust 逻辑或 Adapter 调度接口。Desktop 内部服务不是公开稳定 API，需要聚焦的兼容性与真实调度验收。
