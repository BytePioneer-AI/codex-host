# 外部 Harness 回合文件变更汇总问题与后续方案

> 状态：调查记录与候选方案，尚未实施。本文不表示现有公共契约已支持独立回合净 diff，也不表示所有 Harness 或 Desktop UI 已完成实测。
>
> 关联：[Issue #218](https://github.com/BytePioneer-AI/codex-host/issues/218)、[#134](https://github.com/BytePioneer-AI/codex-host/issues/134)。术语遵循[领域术语表](./领域术语表.md)。

## 1. 问题背景

Issue #218 报告：DSH 在同一 Turn 中反复编辑相同文件，Codex Desktop 回合末尾的文件变更卡片出现多条相同路径，并显示“已编辑 18 个文件”，实际涉及两个文件。报告环境为 codexhost 0.6.0、Codex Desktop 26.901.6511.0、DSH 0.1.1-rc.2、Windows。

这不是简单的标题文案问题。当前投影混用了三种不同语义：

| 层次 | 含义 | 比较或组织依据 |
| --- | --- | --- |
| 操作级文件变更 | 一次工具调用具体修改了什么 | 原生工具调用及其结果 |
| 回合净文件变更 | 一次用户输入触发的 Turn 最终改变了什么 | 该回合可信的文件基线与最终状态 |
| 工作区／分支变更 | 当前工作区或分支相对指定基准改变了什么 | Git HEAD、merge-base 等 |

同一文件被编辑三次，是三次操作，不是三个不同文件；三份操作 diff 的增删数之和也不等于回合净增删数。不同 Turn 默认分别拥有自己的基线，不应无条件跨 Turn 累计。Pi 原生事件中的一次模型响应及工具调用周期也不应直接等同于 Host Turn。

## 2. 当前实现与根因

### 2.1 Adapter 通常逐次产生文件变更

DSH 从成功工具结果的 `meta.diffs` 生成 `HostFileChange`，每次工具结果生成独立 fileChange item。实时与历史共有四条相关路径：

- `packages/adapters/deepseek-harness/src/legacy/deepseek-harness-adapter.ts`
- `packages/adapters/deepseek-harness/src/legacy/history.ts`
- `packages/adapters/deepseek-harness/src/modern/session.ts`
- `packages/adapters/deepseek-harness/src/modern/history.ts`

转换函数位于 `packages/adapters/deepseek-harness/src/projection.ts` 的 `structuredDiffs()`。

Pi 和 Claude Code 也存在逐次产生 fileChange item 的路径：

- `packages/adapters/pi/src/pi-adapter.ts`：`reliableFileChange()` 及工具完成处理。
- `packages/adapters/claude-code/src/tool-lifecycle.ts`：工具完成后投影文件变更。
- `packages/adapters/claude-code/src/file-change.ts`：解析并投影原生结构化补丁。

逐次记录操作本身合理，不应只为减少汇总行数而删除原生操作历史。

### 2.2 公共投影直接拼接操作 diff

`packages/protocol-core/src/codex-ui-projector.ts` 的 `#fileChangeUpdates()` 同时发出：

- `item/fileChange/patchUpdated`：更新当前 item 的 changes。
- `turn/diff/updated`：发送当前回合的 diff。

后者通过 `#allFileChanges()` 展平各 item 的 changes，再由 `diffText()` 直接连接 unified diff，没有计算回合净变化。

```text
文件状态：A → B → C → D

当前输出：diff(A, B) + diff(B, C) + diff(C, D)
正确净值：diff(A, D)
```

因此公共层存在跨 Harness 的风险，不能只给 DSH 做路径去重，也不能据此断言所有 Harness 都已经实测复现。

### 2.3 Desktop 卡片的确切消费链路仍待验证

Issue 中引用的 Desktop 处理代码能说明 fileChange 按 itemId 存储，但不能单独证明最终汇总标题就是按 item 数计数。一个 item 可以携带多个文件，单次工具结果也可能包含同一路径的多个片段。

我们已确认发送给 Desktop 的回合 diff 存在重复路径和非净统计；尚未在报告中的 Desktop 版本上把通知、派生状态和卡片逐一对应。报告中的 19 条 change 与截图 18 行也尚未建立逐 Turn 的精确对应。

## 3. 已执行的验证与边界

以下探针使用当时工作区源码；临时探针未作为回归测试提交，不应视为已经落地的测试覆盖。

### 3.1 DSH：真实原生 diff 函数加当前投影

调用本地安装的 `@deepseek-ai/dsh-tool-fs` 0.1.1-rc.2 的真实 `computeHunkDiffs()`，再经过 DSH `structuredDiffs()` 和公共 `CodexTurnProjector`。不是完整 DSH 会话，也没有启动 Desktop。

| 场景 | 正确净变化 | 当前投影输出 |
| --- | --- | --- |
| 同一文件 a → b → c → d | 一个文件，+1 -1 | 三段同路径 diff，+3 -3 |
| 同一文件 a → b → a | 无净变化 | 两段同路径 diff，+2 -2 |
| 一次操作修改一个 40 行文件的两个远隔位置 | 一个文件、两个变更位置 | 两段同路径文件 diff |

第三个场景原生输出两个 hunk，`oldText` 分别只有 5 行和 6 行，字段只有 `path`、`oldText`、`newText`，不携带原文件行号。这证明其内容是带上下文的局部片段，不是完整文件快照。

公共投影器与 DSH Modern Session 的现有聚焦测试运行结果为 82 项通过；这些测试未覆盖上述净变化问题。

### 3.2 Pi：本地真实 SDK 工具实际编辑文件

使用本地 Pi 0.85.1 的 `createEditTool()`，在临时目录实际连续编辑同一个文件：`alpha → beta → gamma → delta`。结果经过当前 Pi Adapter 转换和公共投影。

- 磁盘最终内容为 `delta`。
- 原生工具返回 `details.diff`、`details.patch`、`details.firstChangedLine`。
- 预期一个文件、净 +1 -1；公共投影输出三段同路径 diff、+3 -3。

这是原生 SDK 工具执行加投影验证，不是模型驱动的完整 Pi RPC 会话，也不是 Desktop 端到端测试。

### 3.3 Claude Code：投影复现，完整 SDK 会话受阻

使用符合 SDK 结构的三次 Edit 结果，经当前原生解析和公共投影，复现三段同路径 diff、+3 -3。这部分是构造数据测试，不是 CC 原生执行结果。

另尝试通过 SDK 启动本地 Claude Code 2.1.133，在隔离临时目录执行三次 Edit；75 秒后主动超时中止，未产生编辑，文件保持原样。超时原因未进一步定位，不能声明 CC 完整会话复现成功。

Pi Adapter、Pi RPC Session、CC 文件变更解析及原生消息相关的四个测试文件共 138 项通过。它们与本问题的定向探针应分开解释。

## 4. 各 Harness 原生数据能力

### 4.1 Claude Code：SDK 有完整基线信息，当前转换丢弃了它

核查仓库安装的 `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`：

- `FileEditOutput` 包含 `originalFile`、`structuredPatch`、`oldString`、`newString`、`replaceAll`。
- `FileWriteOutput` 包含 `originalFile`、完整 `content`、`structuredPatch`，以及区分新增／覆盖的 `type`。

`originalFile` 的契约含义是修改前完整文件内容，但其类型允许 null，必须按工具语义处理缺失情况，不能一律推断为新建。

当前 `parseClaudeNativeFileChange()` 只保留路径、类型和 hunks，没有保留完整原内容。对于原生确实提供完整基线的 Edit/Write，可以在 Adapter 内保留基线，并利用结构化补丁或写入内容恢复当前状态。历史消息是否同样保留这些字段仍需确认。

SDK 另有 `enableFileCheckpointing` 和 `rewindFiles(messageId, { dryRun: true })`。类型声明允许返回 `filesChanged`、`insertions`、`deletions`，但不是完整净 diff 查询接口；本次没有实测该能力。不要把 SDK 文件备份与 Host 的 Native Checkpoint 混为一谈。

### 4.2 Pi：Edit 提供标准补丁，未发现回合净 diff 查询接口

本地 SDK 文档与实际工具结果一致：

- `details.diff` 是面向 TUI 的展示内容。
- `details.patch` 是供 SDK 使用的标准 unified patch。
- RPC 的 `tool_execution_end` 传输工具结果；当前查阅的 SDK/RPC 未发现独立回合净 diff 查询接口。

标准补丁比无位置片段更适合合成，但不等于完整文件基线。要普遍、可靠地计算净变化，还需要可信基线或专门验证过的补丁合成能力。此次仅实测 Edit，Write、覆盖、删除及自定义工具不能由该结果外推。

### 4.3 DSH：当前投影使用的是局部展示数据

原生 `tool/result.meta` 是工具拥有的展示元数据；Session 核心将其作为可持久化的 opaque 数据处理。`DiffResultView` 允许带上下文的局部 hunk，不能把 `oldText/newText` 字段名解释为整文件前后快照。

特别禁止直接使用“同路径首次 oldText + 末次 newText”合并：若首次修改第一段、末次修改最后一段，就会生成原本不存在的修改。

原生文件工具内部确实处理完整 before/after，但不能据此认为现有 Session 接口已将这些内容暴露给 Adapter。后续需检查是否有公共原生接口可获得或保留它们；不能调用私有内部函数作为生产接入方案。

## 5. Codex Desktop 已有能力与接口限制

目前确认可复用的是原生展示通道：

| 接口 | 方向与职责 |
| --- | --- |
| `item/fileChange/patchUpdated` | 后端通知 Desktop 更新某个文件变更 item |
| `turn/diff/updated` | 后端向 Desktop 提供已经计算好的回合累计 diff |

没有在已核查的接入链路中发现“提交外部 Harness 的多次编辑，让 Desktop 自动计算净 diff”的请求接口。原生 Codex 链路能产出累计 diff，不代表这项计算能力作为外部服务开放。

该结论不是对当前安装版所有私有接口的穷尽证明。本次没有完成 Desktop 私有代码全面审计，不建议依赖未公开的 Renderer 内部函数来规避后端累计逻辑。

## 6. Paseo 参考：分离操作记录与工作区汇总

本地参考项目 `reference/paseo` 的相关实现采用不同数据源：

1. 聊天中的 Edit/Write 作为独立工具详情展示，不在这条链路上承诺回合净变化。
2. 工作区变更面板通过独立的 Git 查询获取文件列表、diff 和统计。
3. 未提交模式比较工作区与 HEAD，另处理未跟踪文件；分支模式比较 merge-base 与 HEAD。
4. Codex 通知处理明确指出 `turn/diff/updated` 是整个 Turn 的累计 diff，不是具体工具调用，并在该处理分支直接返回，不生成新的工具记录。

参考源码：

- `reference/paseo/packages/server/src/server/agent/providers/tool-call-detail-primitives.ts`：`toEditToolDetail()`、`toWriteToolDetail()`。
- `reference/paseo/packages/app/src/components/tool-call-details.tsx`：单次工具详情展示。
- `reference/paseo/packages/app/src/git/use-working-diff.ts`：工作区 diff 数据入口。
- `reference/paseo/packages/server/src/utils/checkout-git.ts`：`resolveCheckoutDiffRefs()`、`getCheckoutDiff()`。
- `reference/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts`：`diff_updated` 处理。

值得借鉴的是职责划分，不是一个现成的回合补丁合并算法。Git 工作区 diff 可能混入回合开始前、用户手动或其他 Harness 的修改，不能直接塞进本回合卡片；非 Git 目录也不适用。此次只读源码，没有运行 Paseo。

## 7. 候选实现：保存基线与当前状态，再重新计算 diff

### 7.1 核心模型

不优先实现任意补丁字符串拼接器，而是维护回合内每个文件的可信状态：

```text
原生工具结果／原生累计结果
             ↓
Adapter 解释原生语义
             ↓
可信的回合累计来源
  ├─ 原生回合 diff：直接使用
  └─ 完整基线 + 当前内容／可应用补丁：计算净值
             ↓
每条路径一份净 diff
             ↓
turn/diff/updated
```

概念上，每条路径需要保存首次可信修改前的存在状态与内容，以及当前存在状态与内容。只有变化链连续时，首次修改前状态才能作为该路径在本回合已观察修改的基线；不能无条件声称它覆盖了回合中所有未观察到的写入。

每次成功修改后更新当前状态，使用现有 diff 库重新计算基线到当前的差异。不要等正常结束才第一次输出，以免丢失实时反馈或异常终止前已经发生的修改。

### 7.2 保留操作级记录，独立表达回合汇总

优先候选是保留原有操作级 item，同时让回合累计结果拥有独立、明确的公共表达，不再从全部操作 item 无条件推导。

当前 `HostFileChange` 仅有 `path`、`kind`、`unifiedDiff`，不足以表达完整文件基线。若需要新增快照输入或独立回合 diff 输出，必须同步公共类型、schema、Adapter、协议投影、历史读取及测试；具体字段和事件名尚未设计，不在本文中预设。

现有 `fileChanges.replace` 能替换开放 item 的 changes，但不等于已经支持“保留所有操作 item，再提供独立累计结果”。直接增加一个汇总 fileChange item 还可能被当前 `#allFileChanges()` 再次累加。另一种按回合维护稳定 item 的方案会改变操作卡片语义，须与 Desktop 消费行为一起评估，不能直接复用已 completed 的 item。

### 7.3 责任归属

- Adapter：解析 Harness 私有字段、确定数据真实含义，保留必要的原生信息。
- 通用累计逻辑：仅处理语义明确的完整状态或补丁，不包含 DSH／CC 专用字段判断。若公共抽象尚不成立，可先在有足够原生数据的 Adapter 实现，不强行提取。
- `protocol-core`：投影可信结果到 Desktop；不引入 Harness 专用协议，不默认读取工作区猜测基线。
- Host Runtime：通过公共契约接入，不直接依赖具体 Adapter。
- Renderer：继续复用原生展示，不优先修改私有 UI、标题或计数。

开始改变跨包依赖前，读取 `tools/check-boundaries.mjs`。新增逻辑按职责放置，不继续堆进已有超大 Adapter 或投影模块。

### 7.4 数据不足与连续性失败

需要检测前一次当前状态与下一次原生修改前状态是否一致。失败可能来自用户编辑、其他进程、并发工具、路径别名、换行归一化或遗漏的写入事件。

不得默默将不连续状态合并为准确的 Agent 净变化。降级时保留原生操作记录，不制造净 diff。如何在 Desktop 中避免出现误导性汇总，以及如何清除已经发布但后来失去可信度的累计结果，必须通过消费链路验证后决定，不能只停止发送通知而保留过期结果。

仅在回合结束读取磁盘无法恢复回合前基线；临时加入文件监听、Git 快照、备份或私有文件历史读取也不作为默认修复手段。

## 8. 后续实施步骤

1. 用一个同文件三次编辑的隔离场景，确认 Desktop 的操作卡片、回合汇总、计数与通知之间的实际对应关系；验证独立累计 diff 是否足以修正显示。
2. 明确公共层操作记录与回合汇总的表达，解决当前直接拼接逻辑；数据不足场景的 UI 降级也要有明确行为。
3. 优先验证 CC 的原生完整前内容在实时和历史中都可获取，再实现可信累计；补跑此前超时的真实 SDK 测试。
4. 对 Pi 确认 Edit 基线获取方式，以及 Write／覆盖等结果语义。对 DSH 查找可用的原生完整状态来源；没有依据时不伪造能力。
5. 将脱敏原生事件序列保存为聚焦测试 fixture，日常回归依赖确定性回放，不反复调用模型。
6. 同步实时、历史、取消、异常、断线恢复路径，以及受影响的文档与规格。现有 `openspec/specs/deepseek-harness-fast-session/spec.md` 描述了成功工具结果完成 File Change item，若改变该语义必须同步更新。

## 9. 验收清单

- 同一文件连续修改三次：汇总路径唯一，增删是净变化，操作历史仍完整。
- 同一文件不同位置编辑：不把局部片段误认为整文件。
- 修改后恢复原样：净变化归零，已发布的旧汇总能够更新或清除。
- 新建后修改仍是新增；新建后删除无净变化；修改后删除相对原始内容计算。
- 空文件与不存在文件明确区分；空字符串替换、无末尾换行、CRLF 正确处理。
- 多文件交替修改；绝对／相对路径和 Windows 路径别名不导致重复计数，不跨平台盲目小写路径。
- 取消、失败、断线保留实际已发生的修改；失败工具若部分写入，只按原生可靠结果处理，不推断“失败必定未改文件”。
- 连续性失败、缺失基线、二进制和大文件明确降级，不展示虚假的精确净统计。
- shell、自定义工具等未被观察的写入，不被误称为已经完整覆盖。
- 历史恢复与实时一致；不同 Turn 不串用基线。
- 操作级 diff 与回合 diff 不重复计入汇总；item 生命周期合法。
- 审核与撤销能力单独验证。出现原生按钮或拥有 diff，不等于 Harness 支持相应原生文件操作。

## 10. 当前决策摘要

需要补足的是可信的回合累计能力，而不是简单去重或文案替换。优先比较文件基线与当前状态，复用现有 diff 库；有原生累计结果时直接使用，没有充分数据时明确受限。

目前不实施生产代码，不新增全局文件监听／备份系统，不复制 Paseo 的工作区 Git diff 作为回合结果，也不声称 Desktop 已暴露外部 Harness 可调用的合并服务。后续以本记录为背景，在确认 Desktop 消费行为和原生数据来源后再确定公共契约与具体实现。
