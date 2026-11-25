# Proposal

## Why

CodexHost Web 只会在后台会话完成时自动显示未读提醒，用户不能手动把稍后需要继续处理的会话标为未读。需要在自带会话菜单中提供这一操作，而不是依赖第三方扩展。

## What Changes

- 在未读、未归档且非当前主视图会话的内置行菜单中增加“标记为未读 / Mark as unread”。
- 手动标记复用现有 `completionUnread` 状态，因此会话圆点、收起父会话的未读计数和最近会话提示保持一致。
- 打开会话、重新运行会话及现有清除提醒操作仍会清除手动未读标记。
- 不新增 Host RPC、持久化字段或 Harness 能力，不调用 Codex Desktop 原生 `thread/readState/update`。

## Decisions

- **复用当前 Web 的未读语义**：手动和自动未读都只保存在当前前端运行时，刷新后不恢复，与现有自动完成提醒一致。
- **当前主视图会话不提供该操作**：它已经处于打开状态，避免出现随即被现有清除逻辑移除的未读标记。
- **只增加菜单操作**：桌面和手机复用同一会话菜单，不增加行内按钮或额外的“标记为已读”入口。
- **不改变原生 Desktop 状态**：这是 CodexHost Web 的内置界面能力，不同步 Codex Desktop 的已读状态。

## Capabilities

### New Capabilities

- `web-session-unread`：Web 会话的手动未读入口、状态复用、清除规则和原生状态边界。

### Modified Capabilities

无。现有会话树的未读汇总直接读取同一状态，无需改变其契约。

## Impact

- `apps/web-ui/packages/client/ui-session`：增加设置未读提醒的前端服务操作，并更新状态注释。
- `apps/web-ui/packages/client/ui-workspace`：增加内置菜单组件、注册和中英文文案。
- `docs/product/standalone-web.md`：记录手动未读与自动完成提醒的现行行为及非持久化边界。
- 无新依赖；Host 协议、Mapping Store、Harness Adapter 和 Desktop 原生已读状态不变。
