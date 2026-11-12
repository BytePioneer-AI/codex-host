## Why

DSH `0.2.2-rc.2` 仍写 Session Format V4，Session Remote 与 `0.2.2-rc.1` 相同，但日志多了三处新形状：每个新建的子代理在父会话写入第 3 版 `subagent/catalog`（带同级唯一的 `name`），Team 模式的选择记为必需事件 `team/mode`，Team 任务记录 `ownerName`。Adapter 按精确形状校验日志，因此模型一创建子代理，Session 就在回合中途以 `protocolError` 故障，DSH 却在后台继续执行；之后该 Thread 无法再打开。配置 Team 默认开启时，新建会话即失败。

## What Changes

- 接受第 3 版子代理目录项：`name` 必填，规则与 DSH 相同，mode 为 `continuable` 或 `external`。
- 接受 `team/mode`，只允许布尔 `enabled`。
- Team 任务接受可选的 `ownerName`，且必须同时带 `ownerId`。
- 将 `0.2.2-rc.2` 列入已验证版本，同步低版本提示、插件 notice、连接页与文档。

## Decisions

- 只校验形状，不新增 Item：codexhost 不投影子代理目录与 Team 状态，与已接受的 v0/v2 目录项及其他 Team 记录一致。
- 不检查目录名称在整份日志中的唯一性：这是 DSH 写入时保证的约束，codexhost 不读取名称。
- 升级命令继续跟随 npm `latest`；截至 2026-11-11，`0.2.2-rc.2` 只发布了 GitHub Release，尚未发布到 npm。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deepseek-versioned-web-protocol`: 已验证版本加入 `0.2.2-rc.2`；日志解析接受第 3 版子代理目录项、`team/mode` 与带 `ownerName` 的 Team 任务。

## Impact

- `packages/adapters/deepseek-harness`：`profiles/v4.ts`、`modern/history.ts`、`generation-selector.ts`、`manifest.json` 及测试。
- `packages/renderer-extension`：连接页支持版本文案（中英）。
- 文档：`docs/harnesses/deepseek/` 与 `docs/architecture/` 中提及已验证版本的文档。
- 不改 Host、`shared-contracts` 或公共插件契约。
