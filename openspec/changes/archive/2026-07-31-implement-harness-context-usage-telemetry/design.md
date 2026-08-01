## Context

正式`HarnessAdapter`设计已经描述`HostUsage`，但当前`packages/harness-adapter`源码没有Usage类型，Pi transport不解析`get_state.contextUsage`或`get_session_stats`，External Thread也没有最新Usage状态。当前Codex Desktop随包Binary生成的app-server契约已确认包含：

```text
thread/tokenUsage/updated
params.threadId
params.turnId
params.tokenUsage.total
params.tokenUsage.last
params.tokenUsage.modelContextWindow
```

Paseo提供了经过多Harness验证的架构参考：具体Provider/Adapter把原生Telemetry映射为`AgentUsage`和`usage_updated`，Manager持有`lastUsage`，客户端只读取统一快照。该责任分配适合codexhost，但Paseo的持久化Timeline、Daemon Agent Record和自有UI不适合本项目；其Pi实现只在Turn后异步刷新、首次恢复与手动Compact存在缺口，也不应照搬。

## Goals / Non-Goals

**Goals:**

- 建立可由Pi、Claude Code、ACP或其他未来Harness实现的窄Usage producer契约。
- 让Usage始终来自当前Native Session的结构化事实，不从Transcript、Model ID或UI状态估算。
- 让Host以Thread/Session为键持有一个最新内存快照，并复用同一External Thread路径。
- 通过当前Codex原生Token Usage通知复用现有上下文窗口UI。
- 在创建、恢复、Turn、Compaction、Model改变、重连和关闭边界保持可解释时序。
- 保持Telemetry错误与Agent Loop、Turn终态、Mapping Store和Native Session历史解耦。

**Non-Goals:**

- 不实现跨Harness统一计费、配额、账户或Billing Source语义。
- 不承诺不同Harness的Input、Cache、Reasoning或Cost口径可直接比较。
- 不持久化Usage Timeline、上下文内容或第二份Transcript。
- 不为Renderer增加第二个上下文表盘、轮询器或通用Host请求通道。
- 不在本Change实现Claude Code、官方Codex或其他生产Adapter的Usage producer；官方Codex通知继续透明转发。
- 不实现历史Turn Usage展示或把Session aggregate伪装成每Turn账单。
- 不复制Paseo AGPL代码。

## Decisions

### 1. 使用独立的Session Usage快照，不扩展控制状态

`packages/harness-adapter`增加：

```ts
export interface HostUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  contextWindowTokens?: number;
  contextUsedTokens?: number;
}

export interface SessionUsageChangedEvent {
  type: "session.usage.changed";
  usage: HostUsage | null;
  observedForTurnId?: HostTurnId;
}

export interface HarnessSession {
  readonly initialUsage: HostUsage | null;
  // existing members
}
```

Token字段必须是非负safe integer，成本必须是有限非负数；上下文used/max必须成对出现，max大于零。`contextUsedTokens`允许高于max，以忠实表达原生过量/待Compaction状态；UI负责将视觉比例限制在范围内。

`initialUsage`解决resume返回时的初始快照；`session.usage.changed`是后续完整替换，不是patch。`null`明确清除已经不再适用于当前Native Session或Model的旧值。连续相同快照可以在Adapter或Host去重。

Usage不加入`HarnessSessionState`。当前`SessionStateObserver`的revision用于配置命令确认；如果高频Usage也推进同一revision，Usage事件可能错误满足配置等待器。独立事件同时保持Telemetry与Native Session identity、Model等控制状态的不同变化频率。

现有设计文档中尚未实现的`turn.completed.usage`和`HostTurnSnapshot.usage`不在本Change落地。它们混合了Native Session aggregate与历史Turn scope；本Change会把正式文档修正为Session Telemetry，未来若有两个真实Adapter能提供稳定per-turn Usage，再单独定义带明确scope的历史类型。

替代方案：只在`turn.completed`携带Usage。拒绝，因为它无法表达首次resume、Turn中原生更新、无Agent Loop命令、Compaction或Model切换后的当前状态。

替代方案：给Session增加`getUsage()` Query并由Renderer轮询。拒绝，因为它会建立第二条状态通道、引入轮询和结果时序，并让UI理解Harness Session。

### 2. Usage是可选实际输出，不增加Capability布尔值

Usage与Reasoning、Tool和Question相同：只有原生事实实际出现时才输出。`HarnessSessionCapabilities`不增加`usage=true/false`，因为能力布尔值不能说明当前Model是否报告Telemetry，也不能替代当前值。

Telemetry读取失败不改变Turn outcome，不Fault仍可继续的Session，不阻塞close。Adapter保留最近仍适用的可靠快照；只有Native Session identity或effective Model已经改变，使旧值明确失效时才先发布`null`。诊断保持有界且不包含原始统计、Model、路径或账户信息。

替代方案：把Usage读取失败映射为`session.faulted`。拒绝，因为可选观测故障不应终止真实Agent Loop。

### 3. Pi transport拥有严格统计解析和窄兼容回退

Pi私有transport增加`PiSessionStats`与`getSessionUsage()`，发送结构化`get_session_stats`并解析：

```text
tokens.input/output/cacheRead/cacheWrite/total
cost
contextUsage.tokens/contextWindow
```

只接受实际存在且类型正确的字段；`total`不由组件求和补造，组件也不由`total`反推。上下文pair直接映射为`contextUsedTokens/contextWindowTokens`。

只有`PiRpcUnsupportedCommandError("get_session_stats")`触发`get_state`回退。`PiSessionState`解析器扩展可选`contextUsage`，旧Pi回退只发布该pair。Timeout、Malformed、Process Exit、认证或未知错误不伪装为兼容分支。

刷新边界：

```text
open(resume)                 -> bounded initial Usage read
lazy open(create)            -> initialUsage = null
first/later stable input end -> start refresh for same Native Session
manual/auto Compaction end   -> refresh post-Compaction state
model confirmed              -> invalidate old generation, refresh new state
close/fault                  -> cancel or bound pending refresh
```

当前Pi Adapter将原生Text、Slash Command和Compaction都收敛为一个accepted Host input的稳定终态；因此每个稳定输入终态后的刷新覆盖普通Turn、无Agent Loop命令和Turn内自动Compaction。若后续增加独立out-of-band Compact Command，它必须显式调用同一刷新方法。

每个Session维护`usageGeneration`。开始Session/Model身份改变时递增；刷新捕获generation和Native Session ID，结果只有在两者仍匹配时才可发布。刷新请求在原生稳定边界立即排入RPC命令序列，但不延迟`turn.completed`；结果通过Session事件随后到达，并用`observedForTurnId`关联该边界。

替代方案：维护Model Ref到context window的静态表。拒绝，因为Pi实际Provider和Model状态由Native Session拥有，Model ID不能证明实际窗口。

### 4. External Thread Runtime承担Paseo Manager对应职责

`ExternalThread`增加：

```ts
latestUsage: HostUsage | null;
usageTurnId: HostTurnId | null;
```

注册Session时从`initialUsage`初始化。`#consumeHarnessOutputs`识别`session.usage.changed`，验证事件来自当前ExternalThread持有的Session，原子替换快照并选择关联Turn：事件显式Turn、当前active Turn、最近已对齐completed Turn，按此优先级选择。没有可靠Turn ID时只缓存，不发送Codex通知。

Usage事件不进入`CodexTurnProjector`，因为它可以在Turn终态后出现。Host使用独立的Thread Usage projector；若关联Turn仍有response gate，则先等待响应。`thread/read`恢复并写出Response后，Host对已有latest completed Turn重放一次当前Usage，以支持同进程重访和冷恢复。

Session replacement创建新的ExternalThread运行对象；旧output consumer关闭后才注册replacement。即使旧异步refresh迟到，它也不能写入新对象。Delete、Detach、close和Host shutdown只丢弃内存Telemetry。

Mapping Store不增加字段。Usage不是Thread ownership、Native Ref或Fork Anchor，也不是恢复Native Session所需数据；冷恢复重新向Adapter取当前值。

替代方案：把Usage写入StoredThreadRecord以加速首屏。拒绝，因为值快速陈旧、Native Session才是事实源，而且会引入迁移、跨进程冲突与用户成本数据持久化。

### 5. Protocol Core独占Codex Token Usage carrier

新增纯函数`projectCodexThreadUsage({threadId, turnId, usage})`。Harness Adapter和Host Runtime不使用Codex字段名。

当前生成Schema要求两个完整`TokenUsageBreakdown`。只有以下值存在时才投影：

- `totalTokens`；
- 成对的`contextUsedTokens/contextWindowTokens`；
- 一个真实active或latest completed Host Turn ID。

Carrier规则固定并由差分/视觉Gate约束：

```text
tokenUsage.total.totalTokens  = HostUsage.totalTokens
tokenUsage.total components   = 对应可靠aggregate字段；协议必填但原生未分项的维度为0
tokenUsage.last.totalTokens   = HostUsage.contextUsedTokens
tokenUsage.last.inputTokens   = HostUsage.contextUsedTokens
tokenUsage.last其他components = 0
tokenUsage.modelContextWindow = HostUsage.contextWindowTokens
```

`last`在这里是当前Codex上下文表盘的carrier，不作为codexhost的“上一Turn精确Token breakdown”对外承诺；Renderer不新增分项展示。canonical `HostUsage`仍保留unknown为缺失，不把carrier占位值回写Host状态。若当前Desktop开始展示这些占位分项、或视觉Gate证明该carrier语义不成立，本能力fail closed并停止通知，不能改成猜测式DOM表盘。

成本不进入当前Codex Token Usage通知；Host可保留原生Session aggregate cost供未来明确产品需求使用，但本Change不展示或持久化。

替代方案：让Pi Adapter直接构造通知。拒绝，因为会把Codex app-server变化传播进每个Adapter。

替代方案：Renderer通过固定Request读取HostUsage并自绘表盘。拒绝，因为当前Codex已提供目标通知和UI，第二套控件增加私有DOM、同步与可访问性风险。

### 6. 实时顺序沿用Harness输出，不增加seq或Timeline

`session.usage.changed`与其他Harness输出经过同一个单消费者队列，因此不增加revision、seq或epoch。Host只需要现有response gate和Session对象身份来解决进程内顺序。

这与Paseo的责任划分一致，但不复制其多客户端WebSocket Timeline同步。codexhost不持久化规范化Timeline，断线后从Native Session恢复历史和当前Usage。

高频原生Provider可以在Adapter内按完整快照去重或短窗合并；Pi只在权威边界刷新，不轮询运行中的Token。UI在Turn运行期间可以显示最近可靠值，但不得标记为实时估算。

### 7. 验证按契约、协议和真实UI分层

- Harness contract：Fake Session覆盖initial null/value、完整替换、null清除、Turn终态后Usage、Telemetry失败不改Turn、close有界。
- Pi transport：Fake JSONL覆盖完整stats、context-only、unsupported fallback、malformed、timeout、generation丢弃和不触发fallback。
- Pi Adapter：create/resume、连续Turn、Compaction、Model改变、失败保留与Session隔离。
- Host：两个Fake Harness、response gate、terminal后事件、read后重放、Session replacement、delete/close和不写Mapping Store。
- Protocol Core：当前生成Schema的`total/last/modelContextWindow`固定Fixture、invalid snapshot省略和carrier数值关系。
- Real Pi：显式临时Session smoke只记录字段存在类别、上下文pair关系和刷新结果，不记录原始值。
- Real Desktop：受控合成Pi Thread证明Context Surface出现、百分比与脱敏关系一致、Compaction/续轮刷新、重访恢复；不保存Prompt、Transcript、完整ID、Model或账户数据。

普通`npm run check`不启动Pi、Desktop或网络。

## Risks / Trade-offs

- [不同Harness的Token和成本口径不同] -> 只承诺原生事实与当前context pair；不做跨Harness比较或统一账单。
- [Codex carrier要求完整breakdown而Adapter只有context pair] -> canonical状态保留unknown；Projector使用受控carrier占位且由真实UI Gate约束，不通过则隐藏能力。
- [异步Turn后刷新短暂显示旧值] -> 在稳定边界立即排RPC并关联Turn；不清空仍适用值，也不把估算伪装成实时。
- [Model切换后旧请求迟到] -> generation加Native Session/Model关联，改变时先清除不适用值。
- [恢复时统计读取增加延迟] -> bounded且可失败；Telemetry失败不阻止Session恢复。
- [高频未来Adapter造成输出压力] -> producer去重/合并完整快照；公共契约不暴露每Token delta。
- [Paseo许可证边界] -> 只引用架构和公开行为，独立编码并保持reference目录不提交。

## Migration Plan

1. 先增加Harness Usage类型、Fake contract和单一输出事件测试，不改变现有Adapter行为。
2. 在Pi私有transport增加stats解析、unsupported fallback和Hermetic测试，再接Pi Session刷新边界。
3. 给External Thread增加latest Usage reducer和Session身份隔离，不写Mapping Store。
4. 在Protocol Core增加纯Usage projector并用当前官方生成Schema/合成Fixture约束carrier。
5. 接Host response gate、`thread/read`重放和通知写出，回归官方Codex透明转发。
6. 运行聚焦测试、typecheck、lint、`npm run check`、build与strict OpenSpec validation。
7. 显式运行真实Pi和受支持Desktop Gate；只有可见上下文表盘、续轮/Compaction刷新和重访恢复通过后才宣布完成。
8. 同步HarnessAdapter设计、系统架构、开发清单和脱敏验证记录。

回滚删除Session Usage事件、Pi stats查询、Host latest snapshot和Protocol通知即可。没有Mapping Store迁移、Native Session改写或持久数据清理。

## Open Questions

None. Per-turn历史Usage、跨Harness成本比较和非Pi生产Adapter实现留给有独立原生证据的后续Change。
