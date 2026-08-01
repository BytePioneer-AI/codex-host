## 背景

现有生产垂直切片已经支持不透明的 Pi Model 发现、请求作用域的草稿 Model carrier、仅限 Idle 的 `model.select` 以及由 Host 确认的生效 Model 状态。尽管目标 HarnessAdapter 架构已经定义了 Thinking Catalog 条目、`effectiveThinkingOptionId`、结构化选择能力和仅限 Idle 的命令，生产契约中仍缺少 Thinking。

Pi 0.82.1 暴露了 `get_state.thinkingLevel`、`get_available_thinking_levels` 和 `set_thinking_level`。可用等级取决于当前 Model；`set_model` 可能限制当前等级，而 `set_thinking_level` 可能接受不支持的请求，随后由 `get_state` 报告修正后的生效等级。Pi 的 `set_model` 和 `set_thinking_level` 可能持久化原生默认值，因此无副作用的草稿检查不能在启动后通过修改临时 Session 来探测另一个 Model。

受支持的 Codex Desktop 构建已经能够识别原生的 Model/Reasoning 组合控件，并提供其触发器 class 和设计 token。由于原生 Codex Catalog 和持久化 setter 无法安全表达 Pi 配置，因此 Pi 使用由 codexhost 拥有的控件。

## 目标 / 非目标

**目标：**

- 让 Pi RPC 成为可用 Thinking 值和生效 Thinking 值的唯一权威。
- 保持公共契约足够通用，以支持其他 Harness，同时将 Pi RPC 字段限制在 PiAdapter 内部。
- 将草稿 Model 和 Thinking 选项绑定到精确的 Composer 创建请求。
- 将 Model 和 Thinking 写入与 Turn 串行化，并在命令完成前发布完整且已确认的配置状态。
- 在 Pi 恢复、Fork、Clone 和 Thread 检查时恢复生效 Thinking 及当前选项。
- 呈现一个 Codex 风格的 Model/Thinking 触发器和嵌套菜单，同时保持 Agent、Model 和 Thinking 语义相互独立。
- 当已安装的 Pi 不暴露 Thinking RPC 命令时明确降级。

**非目标：**

- Provider 或 Model allowlist、Provider 特定的 reasoning 参数构造，或上游预算映射。
- 在 Claude Code 的原生 Adapter 暴露等价控件前，为 Claude Code 增加 Thinking 支持。
- 修改官方 Codex Model Catalog、官方持久化 Model setter 或 ASAR。
- 在 Mapping Store 中持久化第二份生效 Thinking，或跨进程缓存原生 Catalog。
- 暴露隐藏的 reasoning 内容，或根据选定 Thinking 选项推断 Reasoning Item。

## 决策

### 1. 扩展规范化配置契约，但不将 Pi 等级暴露为全局 UI 常量

Shared Contracts 增加 `HarnessThinkingOption`、传输安全的选项 ID、当前 Catalog 选项、可选的每个 Model 支持的选项 ID，以及默认/生效选项。Session 状态同时包含生效选项和当前可用选项对象：

```ts
interface HarnessSessionState {
  nativeRef?: NativeSessionRef;
  effectiveModel?: HarnessModelRef;
  effectiveThinkingOptionId?: string;
  availableThinkingOptions?: HarnessThinkingOption[];
}
```

`availableThinkingOptions` 必须属于完整状态，因为 Pi 可能作为 `model.select` 的直接副作用改变它。这样 Host 可以返回一个原子观察到的配置状态，Renderer 也可以立即重建菜单，而无需 Provider 逻辑或第二个可变缓存。Catalog 条目仍然支持 `supportedThinkingOptionIds`，用于草稿检查。

PiAdapter 将 RPC 选项 ID 映射为标签。Renderer 显示这些标签，不得内置 Pi 的七级选项集合。未来出现的未知传输安全 ID 仍然可以由契约表示，但不得被 Renderer 自动宣传为可选等级。

替代方案：从 `reasoning: true` 或 `thinkingLevelMap` 推断所有等级。拒绝原因：这会重复 Pi 的能力逻辑，并且正是 Paseo 过度宣传能力的来源。

### 2. 通过 Pi RPC 探测当前选项和草稿目标选项，但不修改 Pi 默认值

普通检查启动已有的临时 RPC 进程，读取 Model、状态和 `get_available_thinking_levels`，然后关闭进程。为了检查另一个草稿 Model，固定检查输入接收一个不透明的可选 Model Ref。PiAdapter 在内部解码该 Ref，并使用 Pi CLI 的 `--provider` 和 `--model` 启动临时进程；不得调用 `set_model`。Pi 启动会解析目标 Model，并限制原生默认 Thinking 等级，但不得写入默认 Model 设置。

生成的 Catalog 只为被检查的默认 Model 标记精确的 `supportedThinkingOptionIds`；未探测的 Model 不得推测支持情况，而应保持缺省。当草稿选择另一个 Model 时，Renderer 在将返回的 Model/Thinking 对应用到 Composer carrier 前执行目标检查。

替代方案：初始检查时为 Catalog 中的每个 Model 启动一个进程。拒绝原因：这会随用户 Catalog 规模线性增加成本，并让 Composer 等待用户可能永远不会使用的数据。

### 3. 通过命令响应发现能力兼容性，而不是比较版本

PiRpcSession 将针对精确命令返回的 `Unknown command: get_available_thinking_levels` 视为不支持该可选 RPC 能力，但不会因此使进程进入故障状态。检查随后返回空 Thinking Catalog，并将 `configuration.selectThinkingOption` 设为 `false`。其他格式错误或失败响应仍然必须返回明确错误。

当能力为 false 时，Renderer 隐藏 Thinking UI。基于检查结果打开的 Session 获得已经发现的稳定能力。没有事先检查就打开的非 UI Pi Session 可以保守地报告选择不可用，但如果 Pi 返回了可读的生效值，仍然可以发布该值。

替代方案：比较 `pi --version`。拒绝原因：自定义构建和 backport 会使版本推断不可靠。

### 4. Model 和 Thinking 写入共享一个串行化配置临界区

HarnessAdapter 增加：

```ts
type ThinkingSelectCommand = {
  type: "thinking.select";
  thinkingOptionId: string;
};
```

`model.select` 和 `thinking.select` 使用已有的 `#configuring` 排他机制，与 Turn 接受、活动 Turn、历史读取、关闭以及彼此之间进行排他。PiAdapter 执行原生写入，然后调用 `get_state` 和 `get_available_thinking_levels`，在解析 `{completed: true}` 前发出一个完整的 `session.state.changed` 事件。

Thinking 等级被修正仍属于成功的原生配置结果：事件和 UI 使用 Pi 的实际值。如果无法读取写入后的状态，则使 Session 进入故障状态。Model 选择仍然要求 Model 身份精确匹配，但接受并发布 Pi 因此产生的 Thinking 副作用。

### 5. 使用一个完整的 Host 配置投影和一个固定的 Thinking 方法

Shared Contracts 将已有的 Model 选择响应扩展为完整配置状态，并增加 `codexhost/thread/thinking/select`。Host 校验所有权和 `selectThinkingOption` 能力，注册状态 revision 等待器，执行命令，并只返回从有序输出流中消费到的状态。AppServerHost 保持 Harness 通用，不得解释 Pi 选项 ID。

Thread 检查包含生效 Thinking 和当前选项。这样，Pi Fork/Resume 状态可以从已打开的 Native Session 恢复，而不是从 Mapping Store 的 UI 数据恢复。

替代方案：直接从命令结果返回请求值。拒绝原因：这会创建第二条事实通道，并且无法表达 Pi 的修正结果。

### 6. 以兼容方式扩展请求局部的 Pi carrier

已有 carrier 保持有效：

```text
codexhost/pi-native
codexhost/pi-native@<model-ref>
```

带有显式 Thinking 的草稿使用：

```text
codexhost/pi-native@<model-ref>@<thinking-option-id>
```

两个 ID 都不得包含 `@`，且有长度限制并接受运行时校验。Protocol Core 在同一个 `thread/start` 中将这两个值解码为不透明的选择值；Host 将它们传递给 `open(create)`。不得引入进程级 pending 选择或跨通道关联。

首次原生启动时，PiAdapter 应用请求的 Model，观察其被限制后的 Thinking/选项，应用请求的 Thinking，并在 `turn.started` 前发布最终实际状态。后续选定的 carrier 只作为 Turn 前的幂等配置断言。

### 7. 将 Thinking 限定在逻辑 Composer 作用域内

`DraftComposerState` 增加 `piThinkingOptionId`。恢复、替换转移、重新访问、过期请求代数以及新默认 Composer 的重置，都遵循现有 Pi Model 生命周期。应用 Pi optimistic 状态时，始终写入一个包含当前已确认 Model/Thinking 对的 carrier。

Model 变更会从目标检查或 Host 确认状态中同时更新两个字段，因为 Model 选择可能改变 Thinking。Thinking 变更只更新已确认的 Thinking 字段。失败或过期的操作保留之前已确认的配置对。

### 8. 匹配原生 Codex 组合选择器的信息架构

Pi 控件复用已捕获的原生触发器 class 和 Codex token class。其触发器显示规范化的 Model 标签以及有意义的生效 Thinking 标签。主弹出菜单包含当前 Thinking 单选项和 Model 子菜单行；嵌套的 Model 弹出菜单列出规范化 Model。检查、悬停、激活、禁用、下拉背景、ring、shadow 和 backdrop class 使用现有 Codex token。选择 Model 时只关闭嵌套子菜单，主菜单保持打开；Pi 回读完成后在原位置重建该 Model 的 Thinking 选项，避免用户必须重新打开控件才能看到 Model 相关能力。

当唯一选项为 `off` 时，隐藏 Thinking 区域和触发器后缀。只有一个非 `off` 选项时，以只读方式显示。在检查或任一选择等待期间，配置控件和提交操作保持禁用，同时维持稳定尺寸。Agent picker 保持独立。

## 风险 / 权衡

- [Pi CLI 目标检查不同于恢复 Session 的原生上下文] → 目标检查只用于草稿；已打开的 Thread 始终使用自身 Session 的回读状态。
- [可选 RPC 命令失败被错误分类] → 只识别针对精确命令的 Pi 明确未知命令响应；所有其他失败保持为错误，并通过测试覆盖。
- [未来 Pi 的 CLI Model 启动会写入用户配置] → 保留真实的无提示 Gate，在检查前后对相关设置进行快照；如果 Pi 改变这一契约，则停止使用目标检查。
- [Codex 私有样式发生漂移] → 复用已捕获的触发器 class 和稳定 token 名称，保留版本检查；当无法唯一识别原生控件时 fail closed。
- [Carrier 超出 Desktop 或 Mapping Store 的边界] → 将组件及聚合后的运行时长度限制保持在现有 1,024 字符传输字段以内。
- [其他 Harness 使用不同的选项标识] → 保持 ID 不透明、标签由 Adapter 拥有；Host 和 Renderer 不比较语义顺序。

## 迁移计划

1. 增加 delta spec 和严格的浏览器安全契约。
2. 扩展 HarnessAdapter、Fake Harness、Pi transport 和 PiAdapter 状态排序。
3. 扩展 Protocol Core carrier 解码和通用 Host 控件。
4. 扩展 Composer 状态、Renderer client 和组合选择器展示。
5. 增加针对性的契约、Adapter、Host、carrier、状态和 Renderer 测试。
6. 执行 TypeScript 构建/测试、lint/typecheck、严格 OpenSpec 校验，以及有界的真实 Pi RPC smoke check。
7. 只根据实际执行的检查结果更新实现状态文档。

回滚时继续接受两种现有 carrier，移除新的固定方法和 UI 区域，同时保持 Native Pi Session 可读。不需要 Mapping Store 迁移，因为生效状态仍由 Native Session 拥有。

## 待解决问题

- 真实 Desktop 的视觉和交互验收仍需要受控 Renderer Gate，因为本仓库没有独立的 Codex Composer 外壳。
- 未来面向非 Pi Harness 的通用 Renderer 可以在该 Harness 暴露规范化 Thinking 选项后复用这些契约和 Host 方法；本次变更不宣传不受支持的控件。
