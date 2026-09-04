## Why

codexhost 当前只会把自身已经写入 Mapping Store 的 DeepSeek Harness Native Session 恢复为 Codex Thread。用户通过同一 DSH Web profile 创建的既有会话仍由 DSH 正确持久化，但没有显式入口可以将它们加入 codexhost，因此无法在 Codex Desktop 中查看并继续这些历史。

父变更已经为 exact `dsh-v0.1.2-rc.1` 建立完整 Modern `session/follow`、`session/page` 和 `session/control` 恢复链路。rc.1 还提供 cold-safe 的 `session/list`，所以导入不需要复制 Transcript 或在提交 mapping 前再次实现一套历史恢复：只需验证一个现有 Native Session，并创建一条标准 ready mapping。

## What Changes

- 在公共 `HarnessAdapter` 上增加窄的可选 Session Import 候选发现能力；本变更仅由本机、CH-owned、exact `dsh-v0.1.2-rc.1` Modern Adapter 实现，Legacy `0.1.1-rc.2` 和其他 Harness 无需实现且不获得导入能力。
- 通过 authenticated Modern Remote 精确调用 `session/list`，wire args 固定为 `{ _request: {} }`，严格且有界地解析真实 Session ID、cwd、标题、更新时间、blank、origin 和 running 状态。
- 只列出尚未映射、非 Subagent、非 blank、具有合法本地绝对 cwd 的 Session；普通 Fork Session仍可作为独立 Thread 导入，running Session 可见但不可提交。
- 增加两个 DSH Modern-only 固定 Host 方法：列出候选，以及只按 `nativeSessionId` 导入。Host 在写入前重新列举并验证，Renderer 不能提交 cwd、标题或状态作为事实。
- 导入只通过 Mapping Store 的 provisional → ready 事务持久化 Host Thread 与既有 Native Session 的元信息映射，初始 `turnMappings=[]`；不打开 Agent、不读取或复制 Transcript、不调用任何 DSH mutation API。
- ready mapping 立即进入标准 Thread 列表。第一次真正打开 Thread 时，复用现有 Modern resume、journal Snapshot 和 `alignSnapshot()` 懒恢复历史并补齐 Turn mappings。
- 在设置页新增紧凑、可访问、本地化的“会话导入 / Session Import”Tab：单行 Harness 选择器仅启用 DeepSeek，提供刷新、状态说明和每行一个“导入并打开”动作；自动打开失败时保留原始 cwd、复制路径和只重试导航的恢复状态，不增加第二个 Dialog、批量操作或通用 Session 管理页。

## Capabilities

### New Capabilities

- `deepseek-modern-session-import`: exact rc.1 Modern Session 候选读取、Host 侧新鲜复查、mapping-only 导入、并发/回滚及标准懒恢复。

### Modified Capabilities

- `local-deepseek-harness-session`: 将“未映射 Session 永不进入 codexhost”收窄为“只有 exact rc.1 Modern Session 可经用户显式导入后进入”。
- `external-thread-mapping-store`: 定义既有 Native Session 导入如何复用现有 V1 ready mapping、唯一性和崩溃恢复，不改变记录格式。
- `shared-runtime-contracts`: 增加通用、严格、浏览器安全的 Session Import 候选契约，并让两个 method-specific 的 DSH Modern 导入契约复用它。
- `extensible-settings-shell`: 增加只连接本地 Host 的 DSH Modern 会话导入页面及其异步、可访问交互。

## Impact

- `packages/harness-adapter`: 增加可选 `HarnessSessionImportCapability`，只描述标准化候选发现，不包含 Host RPC、Mapping Store 或历史正文。
- `packages/adapters/deepseek-harness`: Modern `session/list` parser/reader 和公共 Facade 对可选能力的 Modern-only 实现。
- `packages/shared-contracts`: 通用候选 Schema，以及 DSH Modern list/import 的固定 Params/Result Schema。
- `packages/host-runtime`: 候选排除、新鲜复查、mapping 事务、固定方法和 `thread/started` 通知。
- `packages/mapping-store`: 将依赖全局 Native Session/Turn 唯一索引的写入放进同一 Store 队列，封闭跨 Host Thread 的提交竞争；不改变 Schema。
- `packages/renderer-extension`: method-specific client、设置页 Tab、本地 Host 路由及复用的 Host-qualified Thread opener。
- OpenSpec、聚焦单元/集成测试和 exact rc.1 compiled artifact Gate。
- 不修改 DSH 源码、Mapping Store V1 Schema、其他 Harness 实现、Rust/native 平台层、依赖或 lockfile。
