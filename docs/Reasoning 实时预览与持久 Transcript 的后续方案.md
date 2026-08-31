# Reasoning 实时预览与持久 Transcript 的后续方案

> 状态：暂不实施，用于记录当前实现、用户体验背景和推荐的后续演进方案。
>
> 本文描述的是 codexhost 对外部 Harness 明确输出的、允许展示的 Reasoning 摘要。它不包含隐藏、加密、redacted、签名或推断出的 chain-of-thought。

## 1. 背景

外部 Harness 可以在一次 Turn 中输出结构化 Reasoning Item。codexhost 已将这些 Item 投影到 Codex Desktop 原生的 Reasoning summary lane：

```text
item/started                         type: reasoning
item/reasoning/summaryPartAdded
item/reasoning/summaryTextDelta
item/completed                       type: reasoning
```

这部分只由 Protocol Core 提供 Codex app-server 数据；Codex Desktop 负责实际 UI。Renderer Extension 不创建 Reasoning 面板、不设置“思考”文案，也不控制原生预览的展开、收起和消失。

受控 Desktop 验证表明，原生 Reasoning summary lane 的正文主要用于 Turn 运行期间的短暂进度展示。完成后正文离开 DOM，只保留原生完成状态或耗时信息；重新打开 Thread 时，也不能依赖该 lane 恢复可检查的 Reasoning 正文。

因此需要同时满足两个不同目标：

1. **实时感知**：Turn 运行时尽量使用 Codex 原生 Reasoning 预览。
2. **完成后留痕**：用户之后仍能确认模型曾经思考，并可查看明确输出的完整 Reasoning 摘要。

## 2. 当前实现

当前原型把一个 Host Reasoning Item 投影成两个平行的 Codex Item。

### 2.1 原生 Reasoning 预览

原始 Item ID 的派生 ID 用于 Codex 原生 Reasoning Item：

```text
<host-item-id>-summary
```

Protocol Core 持续发送 `summaryTextDelta`。Codex Desktop 决定预览如何展示。当前观察到的行为通常是单行、短暂、从累计文本开头截断，因此即使后续 delta 已经发送，用户也不一定能依次看到第二句、第三句。

### 2.2 持久 Reasoning Transcript

原始 Item ID 用于一个额外的 Command Execution Item：

```json
{
  "type": "commandExecution",
  "command": "thinking",
  "aggregatedOutput": "完整 Reasoning 摘要"
}
```

Reasoning delta 同时通过 `item/commandExecution/outputDelta` 写入这个 Item。Codex Desktop 使用原生 Shell/Command Execution UI 展示它，并能在完成 Turn 和历史 `thread/read` 中保留文本。

`thinking` 并不是真实执行的 Shell 命令，而是 `REASONING_TRANSCRIPT_COMMAND` 哨兵值。卡片 UI 是 Codex 原生 UI，但把 Reasoning 包装成 Command Execution 是 codexhost 的兼容投影。

### 2.3 当前时序

```text
Reasoning 首段文本到达
    ├─ start native reasoning preview
    ├─ start commandExecution("thinking")
    ├─ append text to native reasoning
    └─ append the same text to thinking transcript

后续 Reasoning delta
    ├─ append to native reasoning
    └─ append to thinking transcript

Reasoning 完成
    ├─ complete native reasoning
    └─ complete thinking transcript
```

用户体感可能是：

```text
短暂的原生“思考”预览
          +
同时出现或紧接着出现的 $ thinking Shell 卡片
          ↓
原生预览消失，thinking 卡片保留
```

## 3. 当前实现的问题

### 3.1 同一内容同时占用两个展示区域

生成开始后，原生 Reasoning 和 `thinking` 卡片会并行接收相同文本。用户可能误以为模型先“思考”，又执行了一个叫 `thinking` 的 Shell 命令，而不是理解为同一份 Reasoning 的实时预览与持久副本。

### 3.2 短 Reasoning 也会立即显示 Shell 卡片

即使 Reasoning 只有一句、很快完成，`thinking` 卡片也会在第一段文本到达时立即出现。这削弱了 Codex 原生短暂思考体验，并产生不必要的 UI 跳动。

### 3.3 原生预览不保证逐句轮换

持续发送 `summaryTextDelta` 只能保证数据交给 Codex，不能保证 UI 按以下方式轮换：

```text
第一句 → 第二句 → 第三句
```

当前单个 Reasoning Item 使用一个 `summaryIndex: 0`，Codex 可能始终从累计文本开头显示单行截断。延迟创建 transcript 不能解决这个原生展示限制。

### 3.4 Command Execution 是兼容载体，不是公开的 Reasoning transcript 契约

当前实现依赖 Codex Desktop 对 `commandExecution`、`outputDelta` 和 `aggregatedOutput` 的现有渲染行为。它需要继续由 Desktop Contract Audit 和真实 Desktop Gate 验证，不能仅凭 TypeScript 单元测试视为长期稳定的公开 API。

## 4. 后续目标

如果未来继续优化，建议保持以下产品规则：

1. 每个非空 Host Reasoning Item 最终都留下一个持久 `thinking` transcript。
2. 短 Reasoning 也必须留下 transcript，让用户知道该位置确实发生过 Reasoning。
3. Reasoning 开始后的短暂窗口优先使用 Codex 原生预览，避免立即出现重复的 Shell 卡片。
4. 长 Reasoning 在阈值后可以提前切换到持久 transcript，使完整内容在仍然生成时可见。
5. 不为视觉延迟引入跨 Host Runtime 的精确 Timer 调度。
6. Native Session 继续是历史内容的唯一事实源；不把 Reasoning 正文写入 Mapping Store、localStorage 或第二份 Transcript 存储。

## 5. 推荐方案：事件驱动的延迟 transcript

建议使用一个命名阈值，例如：

```ts
const REASONING_TRANSCRIPT_DELAY_MS = 5_000;
```

阈值只决定 transcript **何时开始显示**，不决定是否显示。所有非空 Reasoning 最终都会创建 transcript。

### 5.1 短 Reasoning：阈值内完成

```text
0 ms       第一段 Reasoning 到达，只启动原生 reasoning preview
< 5000 ms  后续 delta 继续发送给原生 preview
completion 一次性 start + complete thinking transcript，内容为完整 Reasoning
```

用户体感：先看到短暂原生思考；完成后留下一个可持久查看的 `thinking` 记录。

### 5.2 长 Reasoning：阈值后仍有 delta

不注册精确 Timer。每次 Reasoning delta 到达时用该事件的 `emittedAtMs` 检查经过时间。

```text
0～5 秒               只发送原生 reasoning preview
第一个 elapsed >= 5s 的 delta
                      start thinking transcript
                      一次性补入此前累计的全部 Reasoning 文本
                      后续 delta 只流式追加到 transcript，或按验证结果决定是否继续原生 lane
completion            complete native reasoning 和 thinking transcript
```

推荐在 transcript 启动后停止发送新的原生 summary delta，以减少重复展示。但是否能够在不破坏 Codex 原生 Item 完成状态的情况下这样做，需要真实 Desktop Gate 验证；在验证前可保守地继续完成原生 Item，但不承诺其 UI 行为。

### 5.3 超过阈值但没有新 delta

例如最后一个 delta 在第 4 秒到达，Reasoning 在第 8 秒才完成。由于没有精确 Timer，第 5 秒不会主动创建卡片；第 8 秒 completion 到达时，一次性创建并完成 transcript。

这是有意的折中：

- 保证最终留痕；
- 避免把同步 Protocol Core projector 变成需要 Host Runtime 主动调度的计时系统；
- 避免 Timer 与 Item completion、Turn cancellation、Host 断开之间的竞态。

## 6. 推荐状态机

每个 Projected Reasoning Item 增加最少的投影状态：

```text
native-preview
    ├─ completion before promotion
    │      └─ start-and-complete transcript → done
    │
    └─ delta at/after threshold
           └─ start transcript with accumulated text
                    ↓
             transcript-streaming
                    └─ completion → done
```

建议状态字段表达真实投影语义，而不是增加通用调度抽象。例如：

```ts
interface ProjectedItem {
  // existing fields...
  reasoningPreviewStarted: boolean;
  reasoningTranscriptStarted: boolean;
  reasoningFirstTextAtMs: number | null;
}
```

累计文本已经存在于 `projected.item.text`，不需要额外维护第二份文本 buffer。

时间应从**第一段非空 Reasoning 文本进入 Codex 投影**开始，而不是从空 `item.started` 或 Turn 开始。这样阈值代表用户实际可感知的 Reasoning 活跃时长。

## 7. 为什么不推荐精确 5 秒 Timer

精确在 5000 ms 主动显示 transcript，需要在没有 Harness 事件时产生新的 Codex 消息。现有 `CodexTurnProjector.project()` 是事件驱动、同步返回消息的投影边界；Timer 会把复杂度扩散到 Host Runtime。

需要额外解决：

- Timer 与 `item.completed` 同时发生时只创建一次 transcript；
- Turn cancellation/failure、Thread 关闭、Host 断开时取消 Timer；
- 多个 Reasoning Item 的独立 Timer；
- Timer 回调与 Harness 输出的串行排序；
- Projector 已完成后拒绝迟到 Timer；
- Runtime 销毁时释放资源；
- 测试中的虚拟时钟和跨包生命周期。

这些成本只换来“卡片恰好在第 5 秒出现”，对核心体验收益有限。因此推荐由下一次 delta 或 completion 触发 promotion。

## 8. 历史投影

历史规则保持简单且一致：每个非空历史 Reasoning Item 始终投影为：

```text
native reasoning Item
thinking transcript Item
```

历史快照不需要记录 Reasoning 当时持续了几秒，也不需要持久化“是否在运行时提前 promotion”。无论短长，完成后都存在 transcript，符合“所有 Reasoning 最终留痕”的产品规则。

Native Session 仍提供 Reasoning 正文；Protocol Core 只在 `thread/read` 时确定性重建 Codex Item，不创建第二份持久内容源。

## 9. 实施边界

建议未来实现时：

- 只修改 Protocol Core 的 Reasoning 投影状态和测试；
- 如无精确 Timer，不增加 Host Runtime Reasoning scheduler；
- 不恢复自定义 Renderer Reasoning 面板；
- 不通过 Renderer 修改原生 Reasoning DOM；
- 保持 HarnessAdapter 的 `HostReasoningItem` 语义不变；
- 不把 5 秒阈值放到具体 Harness Adapter；
- 保持 `REASONING_TRANSCRIPT_COMMAND` 为共享哨兵常量；
- 继续由 Renderer/Desktop Contract Audit 只读检查 transcript DOM 契约，不在该检查器中渲染或修补内容。

## 10. 未来测试清单

### Protocol Core

- 空 Reasoning 不创建预览或 transcript；
- 第一段文本只启动原生预览；
- 阈值内完成时，completion 一次性创建并完成 transcript；
- 阈值后的首个 delta 创建 transcript，并且此前与当前文本各出现一次；
- transcript 启动后的后续 delta 只追加一次；
- 恰好位于阈值边界的事件行为确定；
- succeeded、failed、cancelled 都只完成一次两个 Item；
- 多个 Reasoning Item 独立计时和排序；
- Reasoning 仍位于后续 Tool 和 Agent Message 之前；
- historical Turn 始终恢复完整 transcript。

### Host Runtime 集成

- `turn/completed` 包含确定顺序的 Reasoning preview 与 transcript；
- `thread/read` 重建同样的 completed transcript；
- 不重放 live delta；
- official Codex passthrough 不受影响。

### 真实 Codex Desktop Gate

- 短 Reasoning：原生预览短暂出现，完成后只留下一个 transcript；
- 长 Reasoning：promotion 前不出现 transcript，promotion 后完整文本可见；
- completion 后没有重复文本或永久 in-progress 卡片；
- 切换 Thread 和重启 Desktop 后 transcript 可恢复；
- failed/cancelled 的卡片状态和退出信息不产生矛盾；
- Desktop 更新后 Item ID、`outputDelta`、`aggregatedOutput` 和 DOM transcript 契约仍有效。

## 11. 已知未解决问题

1. **原生逐句轮换**：事件驱动延迟不能保证 Codex 原生预览展示最新一句；这需要独立 Gate 研究 `summaryIndex`、多个 summary part 或其他原生消息形状。
2. **载体语义**：`thinking` 仍显示为 Shell/Command Execution，而不是真正的 Reasoning transcript 类型。除非 Codex 提供更合适的原生持久 Item，否则这是明确的兼容折中。
3. **Item ID 派生**：当前 `${itemId}-summary` 需要评估 opaque Host Item ID 的碰撞风险。
4. **失败状态**：后续实现需要让 transcript 的 `status`、`exitCode` 和 Reasoning outcome 保持一致，不能在 failed/cancelled 时无条件显示成功退出码。
5. **进行中快照**：需要明确 `pendingTurn()` 是否应包含已经 promotion 的 transcript，以支持活跃 Turn 的读取或重连。

## 12. 相关代码与历史资料

当前实现主要位于：

- `packages/protocol-core/src/codex-ui-projector.ts`
- `packages/shared-contracts/src/reasoning-transcript.ts`
- `packages/renderer-extension/src/renderer-transcript-dom.ts`
- `packages/renderer-extension/src/contract-audit.ts`
- `packages/desktop-control/src/contract-audit.ts`

Reasoning 原生 lane 的历史验证资料：

- `openspec/changes/archive/2026-08-03-project-harness-reasoning-into-codex-ui/design.md`
- `openspec/changes/archive/2026-08-03-project-harness-reasoning-into-codex-ui/验证结论.md`

已被当前方向替代的自定义 Renderer 面板方案：

- `openspec/changes/add-optional-reasoning-display/design.md`
- `openspec/changes/add-optional-reasoning-display/specs/renderer-reasoning-summary-surface/spec.md`

该旧方案依赖 Renderer 订阅、ownership inspection、自定义 DOM 面板和偏好设置。当前方向删除了这些运行时展示逻辑，改为只向 Codex 提供原生 Reasoning 和 Command Execution transcript 数据。未来实施本文推荐方案时，不应无意恢复旧的 Renderer 面板架构。
