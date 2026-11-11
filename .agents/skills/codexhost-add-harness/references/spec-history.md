# 身份与历史

对应能力总表：A7–A8、B5–B7、C6。权威接口是 `packages/harness-adapter/src/text-session.ts`；相关 Ref 的 schema 在 `packages/shared-contracts/src/ids.ts` 和 `native-refs.ts`。

## 所有权与身份

| 身份 / 数据 | 所有者 | 用途 |
|---|---|---|
| Host Thread ID、Host Turn ID、映射事务 | Host | Desktop 身份、实时事件关联、持久化协调 |
| `NativeSessionRef` | 插件提供，Host 保存 | 重启后定位同一个原生 Session |
| `NativeTurnRef` | 插件提供，Host 对齐 | 识别同一个原生逻辑 Turn，不代表可以 Fork |
| `NativeCheckpointRef` | 支持 Fork 的插件提供 | 标识可精确派生的历史边界，不是文件快照 |
| 原生消息、分支、Transcript 格式 | 对应 Harness / 插件 | 原生事实来源及其公共快照投影 |

Native Ref 由当前 Harness ID、稳定的原生 ID，以及需要时可持久化的 locator 组成。不能存进程内句柄、凭据或临时生成的随机身份。插件不直接写 Host Mapping Store，也不重新实现 Host 的 Thread 锁、导入去重和替换事务。同一份实现服务多个变体时（如 qoder / qoder-cn），Ref 使用各自的 Harness ID，并拒绝跨变体的 resume、Fork 和 Rollback。

## Create 与 Turn

- create 产生独立的可写 Session，不继承其他 Session 的历史。
- 身份已知时放入 `initialState`。原生延迟创建时，在确认后及时发送 state 事件；身份可以持久化之前，不声称可恢复。
- 普通 Turn 的实时事件始终使用 Host 传入的 turnId；成功终态要提供能与历史对齐的 NativeTurnRef。
- 原生的失败或取消没有落盘时，不伪造 NativeTurnRef；已经落盘时，返回对应的稳定身份和实际 outcome。
- 原生没有直接的 Turn ID 时，可以用稳定的消息/Entry ID，或插件自己维护的持久化记录来对齐（参考 Pi/OMP 的历史边界、Claude 的消息身份），不能用每次读取都重新生成的随机 ID。

## 只读快照

`readSnapshot()` 返回公共的 `HostThreadSnapshot { turns, state? }`，所有插件都必须实现：

- 按原生的有效分支和历史顺序返回逻辑 Turn，不把所有分支拼成一段对话。
- 每个 Turn 包含稳定的 NativeTurnRef、用户输入、公共 Item 和真实 outcome；支持精确派生的边界要提供 checkpoint；已知时附带本轮的 `model` 和原生时间戳 `startedAtMs` / `completedAtMs`。
- 对同一段历史重复读取时，Turn 和 Item 的身份保持稳定。历史损坏、分页缺失或无法确定终态时，明确报错，或使用类型允许的 `unknown` outcome，不能猜测为成功。
- 可以携带本次读取时确认的 state，语义与初始状态和实时状态一致。
- 不发送 Prompt，不触发 Agent，不把旧历史重放到 outputs，也不占用 outputs 的消费者。
- 活动操作期间无法安全读取时可以返回 `sessionBusy`；无法读取时返回明确的错误，不能用空历史冒充成功。

完整的普通 Thread 需要可靠的历史。只能提供实时输出的实现必须报告这一产品限制。

## Resume

接口：`open({ kind: "resume", nativeRef, cwd, environment, knownTurnRefs, model?, thinkingOptionId?, permissionModeId? })`。

- 校验 nativeRef，恢复同一个原生 Session，返回可以继续写入的 Session。
- 处理 Host 提供的 `knownTurnRefs`，让历史与已有的 Host Turn 对齐；原生身份本身已经稳定时，不需要额外重新编码。
- 原生返回了不同的身份时，要失败，不能创建空会话冒充恢复成功。
- 传播本次的 environment 和适用的 cwd。
- **配置提示由 Adapter 负责**：`model`、`thinkingOptionId`、`permissionModeId` 是 Host 从旧映射解码出的持久化提示，不是新的用户命令。Adapter 决定是用它初始化延迟配置、恢复保存的模式，还是保留权威的原生状态；Host 在 open 之后**不会**再补发配置命令。成功后发布原生确认的 state。要区分「这次没读到配置」和「已确认该配置不存在」，避免从旧值复活已经清除的 Thinking 或权限。
- 恢复失败时保留源历史和 Host 的持久化记录，允许之后重试。
- Host 会在空闲释放和故障恢复后调用 resume，与 Host 重启后的冷启动走同一条路径。

当前能力 schema 没有独立的 resume 开关，也没有自动降级为 ephemeral Thread 的路径。原生不支持 resume 时，该分支返回 `unsupported`，并明确这只是受限后端。

## Fork：精确保留前缀并独立继续

仅在 `history.fork` 为 true 时支持；`forkAcrossCwd` 为 true 时必须同时支持 fork（schema 会强制检查）。

- 校验 sourceRef 和 checkpoint 属于同一个 Harness、同一个源 Session，且位置有效；无效时返回 `checkpointNotFound`。
- 保留到指定 Turn 边界为止的历史，创建一个不同的 Native Session，不修改源历史。
- 派生会话的快照与目标前缀完全一致，末轮不能多也不能少；派生的 Session 可以继续执行。
- 跨 cwd 时，要验证原生 Session 确实绑定到了目标目录；只改变子进程的 cwd 不算验证通过。
- 失败时关闭新建的资源。原生支持安全删除派生的临时数据时要回收它，但不能误删源数据。无法回收的持久化副作用必须报告，不能用清理失败掩盖原始错误。
- 原生没有直接的 Fork 时，可以组合公开接口实现，例如「无模型复制 + 原生 `/fork` + 只作用于副本的 rollback」（CodeBuddy、Cursor）。前提是能验证完整的历史前缀，且源会话不变。

Fork 只分叉会话上下文：不回滚文件，不自动创建 Worktree，也不切换 Harness。

## Rollback：去掉最后一个完整 Turn

接口：`open({ kind: "rollbackLastTurn", sourceRef, cwd, environment, model?, thinkingOptionId?, permissionModeId? })`，返回一个去掉最后一轮、仍可继续的 Session，由 Host 执行替换；在 Host 事务成功之前，不能破坏调用方仍在使用的源 Session。

- 源历史非空且没有活动操作；结果恰好少一个逻辑 Turn，而不是少一条消息。
- 保留传入的当前 Model、Thinking、Permission Mode；原生无法保证时，不声明支持该能力。
- 返回有效的身份，并精确保留前缀；只有一轮时，可以得到一个空白但可继续的新 Session。
- 原生没有直接操作时，只有通过 Fork、Clone 等方式能满足上述语义，才能组合实现。
- 失败时不留下半替换的 Runtime 或错误的映射；原生临时资源按 Fork 的规则清理。

这是会话历史操作，不是工作区文件或 Git 的回滚。

## 导入

接口：`adapter.sessionImport.listCandidates()` + `resolveCandidate(nativeSessionId)`。契约见 `packages/shared-contracts/src/harness-session-import.ts` 和 `docs/architecture/harness-session-import.md`。Host、RPC 和设置页已经通用化，现有 13 个插件实现了该接口。

- `listCandidates` 返回浏览器安全的元数据，不包含 locator 和凭据。
- `resolveCandidate` 只读地重新发现并校验选中的 ID，返回 `{ candidate, nativeRef }`；会话已消失时返回 `sessionNotFound`。不能信任上次列表的缓存。**没有实现 `resolveCandidate` 的插件不可导入**，Host 也不会用 ID 拼出默认的原生引用。
- 候选身份必须能被真实 resume；三个地方的 ID 必须相符：candidate、nativeRef、所属 Harness。
- 无法可靠确认原生进程是否在运行时，`running` 设为 null。
- 候选构造、标题归一化、读取生命周期和文件指纹比对使用 `@codexhost/harness-adapter/session-import`（`sessionImportCandidate`、`sessionImportTitle`、`SessionImportScope`、`readStableFiles`、`sameFileFingerprint`），不在插件里重写。
- 原生的发现规则、版本和 locator 由插件负责；映射创建、去重、并发和失败恢复由 Host 负责。

## 验收

1. create 和成功的 Turn 产生可持久化的身份；重复读取快照时，身份和顺序保持稳定。
2. Host 重启后 resume 到同一段历史并继续第二个 Turn，不重放旧事件；恢复提示的取舍符合原生的权威状态。
3. 快照如实反映工具失败、Turn 取消、原生异常和不完整的历史。
4. 支持 Fork 时，验证中间和末尾的边界、源会话隔离、非法 checkpoint，以及声明支持的跨 cwd。
5. 支持 Rollback 时，验证多轮、单轮、空历史、配置保留，以及失败时不破坏源会话。
6. 会话缺失、文件不可读或分页错误、打开失败和关闭路径都有资源清理测试。
7. 支持导入时，验证 list、resolve 和 resume 的身份一致，已消失的会话返回 `sessionNotFound`，损坏的存储被跳过。

Host 集成参考 `packages/host-runtime/src/external-thread-runtime.ts`、`external-thread-fork.ts`、`external-thread-rollback.ts`。
