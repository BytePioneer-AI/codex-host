# Proposal

## Why

#772 已让 Web 通过共享 Host 操作本机官方 Codex Thread，但新建入口、配置和命令仍依赖 `codex-cli` Adapter。结果是同一段对话在 Web 出现两条，两条路径分别启动后台并可能互相占用。官方 Codex 本来就是 Web 投影的目标形态，不需要再包成外部 Harness。

## What Changes

- Web 的 Codex 新建、续聊、配置、排队、命令、置顶和用量统一走官方 Codex Thread，选择器只有一个“Codex”。
- Host 客户端通道按 Thread 所有者分发：Web 使用同一套方法，不区分官方 Codex 与外部 Harness。
- 官方程序优先用 Desktop 自带版本，其次用本机安装的 `codex`。Web 先启动时沿用 Desktop 的启动参数。
- Web 不能回答的官方服务端请求，在 Desktop 不在线时立即失败并提示，不再悬挂。
- 会话被其他 Codex 后台占用时，Web 仍可查看历史，发送时提示占用。
- **BREAKING** 删除 `codex-cli` Adapter、Codex 专用会话导入，以及只为它存在的 `surfaces` 清单字段和 Desktop 原生目录刷新。
- **BREAKING** 旧 `codex-cli` 条目从列表隐藏，不迁移。原生历史仍以官方 Codex Thread 显示。
- 删除未归档的 `web-codex-as-external-harness` 变更。

## Decisions

- **删除 Adapter，不改造它。** 放弃“让 Adapter 连共享后台”：它保留 Codex 到 Harness 再到 Codex 的转换，以及与 Desktop 不同的 Thread ID。
- **不做历史兼容。** 旧条目只隐藏，不提供迁移、ID 别名或双入口过渡期。
- **没有 Desktop 时使用本机 `codex`，仍走同一路径。** 这只决定启动哪个程序，不保留第二套接入。
- **不绕过官方写入限制。** 不删除锁文件、不强行写入，也不自动 Fork。
- **放弃按会话自定义 CLI 路径或版本。**

## Capabilities

### New Capabilities

- `official-codex-web-session`: Web 通过共享 Host 新建和操作官方 Codex Thread，包括启动来源、能力接入、服务端请求和占用行为。

### Modified Capabilities

无。`codex-cli-harness` 与 `harness-plugin-surfaces` 只存在于未归档变更，未进入主规格。

## Impact

- `packages/host-runtime`、`packages/shared-contracts`、`packages/web-server`、`apps/web-ui`。
- 删除 `packages/adapters/codex-cli`，并更新 `scripts/release/harness-plugins.json` 与 `tsconfig.json`。
- 更新 `docs/product/standalone-web.md`、`docs/architecture/host-client-channel.md` 等文档。
- 不新增依赖，不改变 Mapping Store 格式。其他 Harness、通用会话导入和 `codex-usage` 不变。
