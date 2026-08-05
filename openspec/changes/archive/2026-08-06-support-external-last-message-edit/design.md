## Context

Codex Desktop `26.727.40816` 的最后一条消息编辑流程已经完整存在：铅笔入口回填原文本，提交编辑时直接为当前 Thread 发送 `thread/rollback { threadId, numTurns: 1 }`，成功后再发送新的 `turn/start`。codexhost 需要为支持该能力的 External Thread 实现相同协议语义。

当前 Native Session 继续作为完整历史唯一事实源。Host 不解释 Pi Entry、Claude Message 或可见 Transcript；各 HarnessAdapter 通过公开的结构化原生能力实现历史派生。底层可以创建新的 Native Session，但 Desktop 可见的 Host Thread 身份保持不变。

Paseo 证明 Pi/Claude 可以实现更通用的任意 User Message Rewind，但 Codex Desktop 当前没有该交互。本设计只覆盖 Desktop 已有的最后一条可编辑文本消息，不复制 AGPL 代码，也不引入通用 Rewind、自有 UI 或文件恢复。

## Goals / Non-Goals

**Goals:**

- 让支持能力的 ready External Thread 成功处理 Desktop 当前固定的直接 `numTurns=1` 最后一轮 rollback。
- 在当前 Thread 上执行回退，不要求 `forkSource` 或来源 Checkpoint。
- 保持 Host Thread ID、保留 Turn 的 Host Turn ID、Harness 所有权、cwd、管理元数据和 Desktop Session tree 身份。
- 创建不同的 Native Session，其活动历史恰好是当前历史去掉最后一轮；唯一一轮被删除时允许空历史。
- 保持当前 Native Session 已确认的 Model 和 Thinking 配置，使编辑后的 Turn 使用用户当前选择。
- 在 Native 派生或 Mapping Store 提交失败时继续以旧 Session、旧映射和旧 Runtime 为权威。
- 保持既有 `thread/fork`、post-Fork rollback、官方 Codex 透传和 Desktop 原生 UI 行为。

**Non-Goals:**

- 任意历史 User Message、Assistant/Tool 节点或 Pi 非活动分支的 Rewind。
- 普通 External Thread 的 `numTurns>1` rollback。
- 自动重新发送、恢复附件、图片或原生 Tool 输入。
- 回滚、复制、快照项目文件或管理 Worktree。
- Renderer Extension、Desktop Control 或 Codex Desktop UI 修改。
- Claude Code 的最后一轮编辑支持；其能力在本 Change 中保持 false。
- 新的持久化格式、Transcript 缓存、Native Session 删除或垃圾回收。

## Decisions

### 1. 增加专用 rollbackLastTurn Session open mode

`HarnessSessionCapabilities.history` 增加 `rollbackLastTurn: boolean`，`HarnessAdapter.open()` 增加窄化输入：

```ts
{
  kind: "rollbackLastTurn";
  sourceRef: NativeSessionRef;
  cwd: string;
}
```

Adapter 只在输入的当前 Native Session idle 且至少有一轮时创建不同 Native Session。结果 Snapshot 必须等于其当前活动历史的精确短一轮前缀，可以为空；结果 Session 必须保持当前 Native Session 已确认的 Model 和 Thinking 配置。输入 Native Session 和项目文件不得改变。能力为 false 时必须在创建 Native 资源前返回 `unsupported`。

该操作返回新 Session，因此继续属于 `open()`，不作为当前 Session 的 `HostCommand`。它不接收任意 Turn Ref 或 Checkpoint，从接口层阻止本 Change 演变为通用 Rewind。

替代方案：要求所有 Adapter 原地移动同一 Native Session 的历史位置。拒绝，因为 Pi 的交互式 `/tree` 没有对应的公开 RPC command，Claude Agent SDK 也没有完整 Rewind 原语；Host Thread 身份不应绑定到底层实现是否更换 Native Session ID。

### 2. 最后一轮回退是当前 Thread 的独立操作

Host 对 Desktop 直接发送的 mapped External `thread/rollback { numTurns: 1 }` 执行当前 Thread 的最后一轮回退。该路径不要求 Thread 具有 `forkSource`，也不从其他来源 Thread 的 Checkpoint 重建历史，只要求：

```text
numTurns == 1
当前 Thread idle
当前映射至少一轮
session.capabilities.history.rollbackLastTurn == true
ready NativeSessionRef 可用
```

当前 Thread active、普通 External `numTurns>1`、能力为 false、空 Thread 或无 Native 身份均显式失败，不得转发官方 Codex。未映射的 rollback 原帧继续透明转发。

`thread/fork` 和既有 post-Fork rollback 继续由各自规范处理。它们不属于最后一条消息编辑能力，也不改变本操作始终针对当前 Host Thread 当前活动历史的语义。

### 3. Host 验证身份和单轮前缀，Adapter 保证原生语义

最后一轮编辑路径调用 owning Adapter 的 `open(rollbackLastTurn)`，读取返回 Session Snapshot，并验证：

- 新 Native Session ID 不同于旧 Session；
- 新 Snapshot Turn 数恰好为旧映射数减一；
- 每个保留位置都有可重建的 Native Turn Ref；
- Harness 和 Native Session 身份均属于新 Session；
- 新 Session 报告的有效 Model 和 Thinking 与当前 Native Session 已确认配置一致。

精确“当前历史去掉最后一轮”由 Adapter 能力契约负责；Host 不比较 Prompt、Transcript 或 Harness 原生 ID。Host 按序复用前缀 Host Turn ID，并从新 Snapshot 重建 Native Turn/Checkpoint refs。零 Turn 时返回 `turns: []`。

替代方案：在 Host 中比较可见文本。拒绝，因为可见投影不是完整历史事实源，且会把内容带入身份逻辑。

### 4. Mapping Store 增加专用原子替换

Mapping Store 增加面向最后一轮编辑的 ready Session 替换操作。它只接受：不同的新 Native Session、当前 Turn mappings 的精确短一轮 Host ID 前缀，以及匹配新 Session 的 Native refs；前缀可以为空。操作保持 `forkSource`、cwd、title、archive、transport carrier、timeline metadata 和其他记录字段不变。

该操作复用现有每 Thread 写队列、严格 Schema、backup 和原子 replace；持久替换成功后才更新索引。失败时旧记录和索引保持权威。单独方法不会改变现有 post-Fork rollback 验证。

Host 在提交失败时关闭新 Runtime，并继续使用旧 Runtime。提交成功后才替换 Runtime并有界关闭旧进程；旧 Native Session 历史文件不删除。

### 5. Pi 通过结构化原生能力派生当前历史

PiAdapter 的 `rollbackLastTurn` 流程为：

```text
校验来源 Ref 和 cwd
→ pi --mode rpc --fork <source-session> 创建完整独立副本
→ 读取副本当前活动 Entries、Model 和 Thinking
→ 找到最后一个 User Entry
→ RPC fork(lastUserEntryId) 排除该轮及其后继
→ 恢复并确认当前 Native Session 的 Model 和 Thinking
→ 读取最终 Snapshot
→ 验证最终 Session 身份不同且 Turn 数精确少一
→ 返回最终 HarnessSession
```

当来源只有一个 User Turn 时，同一原生操作必须产生零 Turn Snapshot；若当前 Pi 不能证明该结果，Adapter 返回明确 native failure，不回退到消息重放、Session 文件改写或隐式新建会话。

Pi inspection 和 opened Session 均报告 `rollbackLastTurn=true`。Claude Code、Fake 的默认配置和其他未实现 Adapter 报告 false。

### 6. 验证保持聚焦

新增测试限于会改变实现方向或保护持久化边界的场景：

- Shared Contracts/Harness Fake：能力 Schema、unsupported 和 invalid-state 行为。
- PiAdapter：两轮变一轮、单轮变空历史、来源 Snapshot 不变，以及 Model/Thinking 保持。
- Mapping Store：空前缀成功和一次注入写盘失败后旧记录仍权威。
- Host Runtime：普通两轮 Thread 单轮 rollback、首轮 rollback、当前 Thread active、普通 `numTurns>1` 和 unsupported 拒绝；既有 post-Fork 和官方透传测试继续通过。
- 一个受控 Windows Desktop/Pi Gate：编辑最后一条文本、修改后重发、确认同一 Host Thread 可继续、Model/Thinking 正确且未修改文件。

不新增任意节点矩阵、跨平台重复 Gate、长历史性能、附件、文件 Rewind 或 Claude real E2E。本 Change 运行受影响包测试、必要的类型/格式检查和一次真实 Desktop Gate；不因该窄功能扩建全量测试基础设施。

## Risks / Trade-offs

- [Desktop 后续版本改变 rollback 序列] → Gate 锁定当前受支持 build；未知形状 fail closed，不增加 Renderer 猜测。
- [Pi 对第一个 User Entry 执行 fork 的空历史行为不成立] → Adapter 读取最终 Snapshot 并严格验证；不成立则明确失败，不改用文本重放。
- [历史派生恢复了边界处的旧 Model 或 Thinking] → Adapter 重新应用当前 Native Session 已确认的配置，Host 在提交前验证最终有效状态。
- [Native 派生成功但 Store 写入失败] → 来源 Session 未被修改，新 Session 关闭并保留其原生历史文件，旧 Runtime/Store 继续权威。
- [保留 Fork-derived Thread 的旧 `forkSource`] → 它继续表达 Thread 来源；最后一轮回退不依赖该字段，既有 post-Fork 操作仍按其独立规范验证。

## Migration Plan

1. 增加 Shared Contracts、HarnessAdapter open mode 和 false-by-default Fake/Claude 能力，不改变 Host 路由。
2. 实现 Pi 原生 `rollbackLastTurn`、Model/Thinking 保持并完成聚焦 Adapter 测试。
3. 增加 Mapping Store 专用原子替换及 Repository 对齐。
4. 在 Host 中接入独立的当前 Thread 单轮 rollback，同时保持既有 Fork 路由不变。
5. 更新 PRD、架构、Adapter、持久化和开发清单中的当前边界，运行聚焦检查和一次真实 Desktop/Pi Gate。

回滚时移除新能力、open mode、Host 路由和 Store 专用方法即可；V1 记录格式没有变化。已经成功编辑过的 Thread 仍是合法 ready 记录，可按其新 Native Session 正常恢复，不删除任何 Native Session。

## Open Questions

无。
