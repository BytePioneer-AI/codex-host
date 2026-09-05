# Thread 生命周期与 History

本文说明外部 Harness 的 Session identity、Turn identity、快照、恢复、Fork 和 Rollback 语义。权威接口位于 `packages/harness-adapter/src/text-session.ts`，Host 集成位于 `packages/host-runtime/src/external-thread-runtime.ts`、`external-thread-fork.ts` 和 `external-thread-rollback.ts`。

## 三层身份

必须区分：

- Host Thread ID：codexhost 和 Desktop 使用，由 Host 创建并持久化。
- `NativeSessionRef`：原生 Harness 会话身份，由 Adapter 提供。
- `NativeTurnRef`：原生历史中的稳定 Turn 身份，用于 Host Turn 对齐。

支持 Fork 时还需要 `NativeCheckpointRef`，它表示可派生到某个 Turn 边界的原生位置。

所有 Native Ref 必须：

- 使用当前 Adapter 的 `harnessId`；
- 包含稳定、非空的原生 ID；
- 能在进程重启后重新定位同一原生数据；
- 不包含凭据或仅当前进程有效的对象句柄；
- 需要附加路径或格式信息时使用可持久化的 `locator`。

## Create

`open({ kind: "create" })` 应产生独立、可写的 Session：

- 不继承另一个 Session 的历史；
- 初始 Native identity 已知时放入 `initialState.nativeRef`；
- 原生系统延迟分配 identity 时，在第一轮启动后及时发布 `session.state.changed`；
- identity 可持久化之前，不能将 Thread 当作可恢复会话宣布成功；
- 创建失败必须清理原生 Session，不保留半持久化 Thread。

## Turn identity

每个被接受的 Host Turn 都应最终映射到稳定 `NativeTurnRef`：

- `turnId` 由 Host 提供，所有实时事件都使用该 ID；
- `nativeTurnRef` 来自原生历史，用于重启后的对齐；
- 成功 Turn 缺少 `nativeTurnRef` 会导致 Host 无法可靠持久化；
- 失败或取消 Turn 在原生系统未保存历史时可以没有 Native Turn identity；
- 同一个原生 Turn 不得映射到多个不同的 Host Turn。

Adapter 可以在 Turn 开始前读取历史边界，在完成后重新读取并找出新增 Native Turn。Pi 和 OMP 是该模式的主要参考。原生系统允许调用方写入消息 ID 时，可参考 Claude Code 预先建立 Native Turn key 的方式。

## `readSnapshot()`

`readSnapshot()` 返回完整、只读的 `HostThreadSnapshot`：

- Turn 按原生历史顺序排列；
- 每个 Turn 包含稳定 `nativeTurnRef`、用户文本输入、已完成 Item 和 outcome；
- 支持 Fork 的 Turn 在可派生边界提供 `checkpoint`；
- 可提供当次读取确认的 Session 配置状态；
- 重复读取相同历史应得到稳定 identity 和 Item ID；
- 不启动 Turn、不发送输入、不消费实时事件、不触发 Agent；
- 不将读取到的旧历史重新发到 `outputs`；
- 不能可靠读取时返回类型化错误，不返回伪造的空历史。

活动 Turn 的实时内容由 `outputs` 和 Host projector 维护；快照主要用于恢复、对齐和终态刷新。Adapter 可以在活动操作期间返回 `sessionBusy`。

## Resume

`open({ kind: "resume" })` 应：

- 验证 `nativeRef.harnessId`；
- 打开完全相同的 Native Session identity；
- 如果原生系统返回不同 identity，则以 `sessionNotFound` 或 `protocolError` 失败；
- 接收并利用 `knownTurnRefs` 保持 Host 与 Native Turn 对齐；
- 通过 `readSnapshot()` 返回既有历史；
- 保持 Session 可继续写入；
- 传播新的 `cwd` 和 `environment` 到本次执行进程，但不得因此改变 Native identity。

恢复失败时 Host 仍保留持久化记录，便于之后重试；Adapter 不得创建一个空 Session 冒充恢复成功。

## Fork

仅当 `capabilities.history.fork` 为 true 时支持 `open({ kind: "fork" })`。

Fork 必须：

- 验证 `sourceRef` 和 `checkpoint` 属于同一 Harness、同一源 Native Session；
- 保留到 Checkpoint 为止的历史；
- 创建与源 Session 不同的 Native Session identity；
- 不修改源 Session 或源历史；
- 返回可继续写入的派生 Session；
- 派生快照在语义上截止于目标 Checkpoint 所表示的 Turn 边界；Fork 可以重新分配 Native Session、message、Turn、Checkpoint 和 Item ID，但不能改变保留历史的内容或丢失该边界的 Checkpoint presence；
- 失败时删除已经创建的派生原生 Session。

`forkAcrossCwd` 为 false 时，只允许派生到源 cwd。为 true 时，Adapter 还必须验证原生 Harness 确实能够在目标 cwd 中安全继续，而不是只修改进程工作目录。

参考选择：

- CLI/RPC 与跨 cwd：Pi；
- 带 Subagent 的 RPC：OMP；
- Transcript 原生 Fork、同 cwd：Claude Code；
- 只有 ACP 私有扩展可用时：Grok。

## History replacement fence

`history.replacementFence` 声明当前 Session 的 `close()` resolve 可以作为历史替换的 Native work、Transcript 和 Workspace fence。它是可选字段，遗漏与 `false` 等价；普通资源清理和 `outputs` 结束不构成这个保证。

Host 只有在当前权威 Session 明确声明 `replacementFence=true` 时，才可执行会替换其 Native Session identity 的 direct rollback 或 legacy Fork rollback。Host 在提交 Mapping Store 前关闭并排空当前 Session，并在 commit 边界再次检查 capability。Adapter 返回的候选 Session 也必须声明相同 fence，否则 Host 必须在恢复配置、读取候选历史或写 Store 前拒绝它。

`fork=true` 不蕴含 replacement fence，因为普通 Fork 不需要关闭或替换源 Session。`rollbackLastTurn=true` 则必须与 `replacementFence=true` 同时出现，共享 schema 会拒绝缺失或显式 false 的组合。

## RollbackLastTurn

`rollbackLastTurn` 的公共语义不是在原 Session 上破坏性删除，而是返回一个已经去掉最后一个 Turn、仍可继续的 Session。Host 随后用它替换当前外部 Thread 的 Session。

必须满足：

- 源历史至少有一个 Turn；
- 没有活动 Turn；
- 结果恰好少一个 Turn；
- 保留当前有效 Model、Thinking 和 Permission Mode；
- 返回有效 Native identity；
- 对源历史和派生历史做身份归一化后的完整语义前缀比较：Fork 重建时 Native Session、message、Turn、Checkpoint 和 Item ID 可以变化，不参与跨 Session 相等性；必须比较 Turn 顺序、输入、Item 语义及其 Outcome、Turn Outcome 和 Model，并保留每个对应 Turn 的 Checkpoint presence，不能只比较 Turn 数量或任何原生 key/ID；
- 源 Session 在替换完成前仍保持可回滚失败的安全状态；
- 失败不应留下半替换 Runtime 或错误持久化记录。

原生系统没有真正 Rollback 时，可以通过 Fork 到倒数第二个 Checkpoint 实现。只有一个 Turn 时，结果应是新的空白可继续 Session。参考 Pi、OMP 和 OpenCode；Claude Code 当前因空 Session 无法持久恢复而不声明此能力。

Host 在写入 Mapping Store 前会关闭并排空显式声明 `replacementFence=true` 的旧 Session，把 `close()` 当作原生执行 fence。提交失败后旧映射仍是权威来源，Host 会在下一次访问时用它冷恢复，而不是继续使用已经关闭的 wrapper。

## 快照投影规则

历史 Item 必须使用公共 `HostItem` 类型：

- Agent 回答：`agentMessage`
- 可见 Reasoning：`reasoning`
- Shell 或明确命令：`commandExecution`
- 其他工具：`toolExecution`
- 文件修改：`fileChange`
- 压缩：`contextCompaction`
- Subagent：`subagentDelegation`

历史中的 Item 应具有稳定 ID，outcome 应反映 Item 自身结果。Tool 失败不必使整个 Turn 失败；以原生 Turn 的最终结果为准。

## History 能力完成标准

声称支持持久化 History 前，至少验证：

1. create 后得到稳定 Native Session identity。
2. 成功 Turn 得到稳定 Native Turn identity。
3. 重复 `readSnapshot()` 不改变 identity、顺序或内容。
4. Host 重启后 resume 返回同一历史并可继续新 Turn。
5. 支持 Fork 时，源与派生历史隔离。
6. 支持 Rollback 时，结果恰好少一个 Turn且配置不变。
7. 失败、取消和不完整原生历史不会被错误标记为成功。
8. 所有打开路径都正确关闭失败过程中创建的原生资源。
