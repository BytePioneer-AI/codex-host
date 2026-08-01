## 背景

现有生产垂直切片已经支持不透明的 Pi Model 发现、请求作用域的草稿 Model carrier、仅限 Idle 的 `model.select` 以及由 Host 确认的生效 Model 状态。Pi 0.82.1 还暴露 `get_state.thinkingLevel`、`get_available_thinking_levels` 和 `set_thinking_level`，并在内部根据 Model 元数据完成统一档位到 Provider 参数的映射以及不支持请求的回退。

最初实现为每个 Draft 目标 Model 启动一个带 `--provider/--model` 的临时 Pi 进程，以读取该 Model 的精确 Thinking 列表。真实计时显示已启动 Pi 中读取列表只需 0-1ms，但目标检查需要约 364-441ms，首次检查约 692ms；Renderer 随后还要串行清理 stale official prewarm，导致用户感知接近 1 秒。

本次产品范围只面向 Pi。Pi 的 `get_available_models` 为每个 Model 提供稳定的 `reasoning` 布尔能力，Pi 自身接受统一 Thinking 请求并负责回退。因此 Draft 不再逐 Model 探测，改为一次构造进程内 Catalog；Native Session 打开后的实际状态仍来自 Pi。

## 目标 / 非目标

**目标：**

- Pi inspection 只启动一次临时进程并返回完整 Draft Model/Thinking Catalog。
- reasoning Model 暴露 Pi 统一的七个请求档位，非 reasoning Model 只暴露 `off`。
- Draft Model 切换只使用内存 Catalog，并继续把 Model/Thinking 请求绑定到精确 Composer 创建 carrier。
- codexhost 不实现 Thinking clamp、预算或 Provider 参数映射；Pi 独立处理请求。
- Existing Thread、首次 Turn、恢复、Fork 和 Clone 继续投影 Native Session 实际 Model/Thinking 状态。
- Model/Thinking 写入与 Turn 串行化，失败时不回退到 Codex。
- 当已安装 Pi 缺少 Thinking RPC 控制时明确降级。

**非目标：**

- 为非 Pi Harness 发布统一的静态 Thinking Catalog。
- 声称 Draft 列表是远端 Provider 原生能力或不同档位一定产生不同效果。
- 在 codexhost 中复制 Pi 的 `thinkingLevelMap`、`clampThinkingLevel`、reasoning budget 或 Provider payload。
- 为所有 Model 预先启动独立 Pi 进程，或维护跨进程持久化 Catalog。
- 修改官方 Codex Model Catalog、官方持久化 Model setter 或 ASAR。

## 决策

### 1. 保留通用 Catalog 结构，由 PiAdapter 拥有统一 Draft 档位

Shared Contracts 继续提供 `HarnessThinkingOption`、transport-safe ID、Catalog 级选项和每个 Model 的 `supportedThinkingOptionIds`。PiAdapter 定义 Draft 统一档位：

```text
off, minimal, low, medium, high, xhigh, max
```

Model 关系只由 Pi `get_available_models.reasoning` 决定：

```text
reasoning=true  -> 全部七档
reasoning=false -> off
```

这组值表示用户向 Pi 提交的请求，不表示远端 Provider 原生支持七个不同档位。Pi 可以把多个请求映射到相同 Provider 参数，也可以把 `max` 回退到 `high`。Renderer 只消费 Adapter Catalog，不维护 Pi 常量。

Catalog Schema 必须拒绝重复 Model Ref、重复 Thinking ID、同一 Model 内重复支持 ID，以及不存在于 Catalog 的支持关系。Pi 原生 Model 的 base URL、价格、认证、路径、`thinkingLevelMap` 和其他字段不得穿透 Adapter。

### 2. inspection 一次读取完整 Draft Catalog，不接受目标 Model

`HarnessAdapter.inspect({cwd, refresh})` 启动一个临时 Pi RPC 进程，读取当前状态、`get_available_models` 和一次 `get_available_thinking_levels` 能力探测，然后关闭进程。Pi Model Catalog 项必须提供布尔 `reasoning`；缺失或类型错误视为协议错误。同一原生 Model 重复出现且 reasoning 值冲突时检查失败。

成功的ready结果按cwd缓存在PiAdapter内存中；同cwd并发检查共享一个in-flight Promise，普通后续检查直接返回缓存，`refresh:true`显式重建并替换缓存，失败结果不缓存。缓存只活到Adapter关闭，不进入Mapping Store或磁盘。

检查不再接受目标 Model Ref，也不使用 `--provider/--model` 为 Draft 切换启动第二个进程。当前 Native Model 仍作为 Catalog 默认 Model；当前 `thinkingLevel` 如果属于统一七档，则作为初始默认请求值。

`get_available_thinking_levels` 在 inspection 中只用于确认安装的 Pi 是否提供 Thinking 控制，以及校验当前状态自洽；它不决定其他 Draft Model 的菜单内容。

### 3. 通过命令响应发现旧 Pi 兼容性

针对精确 `get_available_thinking_levels` 命令的 `Unknown command` 仍表示该安装缺少可选 Thinking 控制。检查保持 Model ready，但返回空 Thinking Catalog，并将 `configuration.selectThinkingOption=false`。其他格式错误或失败仍为明确错误。

不通过版本号、Provider 名称或 Model ID判断兼容性。统一七档只在已确认 Thinking RPC 控制存在时发布。

### 4. Draft 保存请求值，Pi Session 拥有实际值

`DraftComposerState.piThinkingOptionId` 表示用户请求。Draft 选择 Model 时：

1. 从当前内存 Catalog 找到目标 Model；
2. 如果之前请求值仍在目标 Model 的静态列表中则保留；
3. 否则使用 Catalog 默认值或目标列表第一项；
4. 同步写入 Model/Thinking carrier；
5. 清理 stale official prewarm；
6. 不调用 Host inspection 或 Pi setter。

首次 Turn 启动 Native Session 时，PiAdapter按 Model、Thinking 请求顺序应用配置。Pi 内部可以回退 Thinking；codexhost 不计算替代档位。PiAdapter读取 Native Session 状态并在 `turn.started` 前发布完整状态。

因此 Draft 中可以显示请求的 `max`，而 Native Session 创建后显示 Pi 报告的 `high`。这是从请求状态进入实际 Session 状态，不是 codexhost 执行校正。

### 5. Native Session 写入保持有序状态流

HarnessAdapter 保留 `thinking.select`。`model.select` 和 `thinking.select` 共用 `#configuring` 临界区，并与 Turn 接受、活动 Turn、历史读取和关闭排他。

PiAdapter只调用原生 `set_model`/`set_thinking_level`。写入后继续读取 `get_state`；当前 `get_available_thinking_levels` 可作为 Session 实际菜单状态发布。Pi 返回的状态可以不同于请求，Host 和已存在 Thread 的 Renderer 使用该实际状态。这个读取不是 codexhost clamp，也不构造 Provider 参数。

如果 Model 身份无法确认或写入后的状态不可读，Session fault。Thinking 请求被 Pi 内部回退仍是成功配置结果。

### 6. Host 保持固定方法和完整状态投影

Shared Contracts 保留固定的：

```text
codexhost/harness/inspect
codexhost/thread/model/select
codexhost/thread/thinking/select
codexhost/thread/inspect
```

Harness inspection 参数只包含 Harness ID、可选 cwd 和 refresh。Host 不暴露任意 Harness/Pi RPC 逃逸口。

Existing Thread 的 Model/Thinking 选择通过所属 HarnessSession 和结构化 capability 分发。Host 注册状态 revision 等待器，执行命令，并返回有序输出流中观察到的实际配置状态，不按 Harness ID解释选项。

### 7. carrier 继续绑定 Composer 请求

兼容 carrier 保持：

```text
codexhost/pi-native
codexhost/pi-native@<model-ref>
codexhost/pi-native@<model-ref>@<thinking-option-id>
```

Model Ref 和 Thinking ID 都是不透明、有界且 transport-safe 的值。Protocol Core 只解码 Harness 所有权和选择值；Host 将其传给 `open(create)`。不得引入进程级 pending 选择或跨 Composer 共享请求值。

Model/Thinking 的 Draft 选择仍在更新 optimistic Model atom 后调用 official local prewarm clear；提交期间冻结最终 carrier。

### 8. Renderer 使用一份内存 Catalog

Pi 控件继续使用 Codex 风格 Model/Thinking 组合触发器。初次选择 Pi 后只加载一次 Catalog；Draft Model 子菜单选择同步从内存关系解析 Thinking 请求并写入 carrier，不再发 inspection 请求。official local prewarm clear 仍是选择完成条件；清理期间控件保持 `selecting`，成功后才确认新 Model/Thinking 菜单，失败则恢复旧 carrier 和控件状态。

reasoning Model 显示统一档位；非 reasoning Model 只有 `off` 时隐藏 Thinking 区域和触发器后缀。只有一个非 `off` 选项时只读。缺少 `supportedThinkingOptionIds` 的 Model 不得回退到 Catalog 全部选项。

Existing Thread 的 Model/Thinking 选择仍在等待 Host 状态时禁用配置和提交，并用 Pi 实际状态更新当前 Model 的列表。请求 generation、Composer 替换、Agent 切换和销毁仍使旧异步结果失效。

## 风险 / 权衡

- [Draft Catalog 过度宣传 xhigh/max] -> 明确其为 Pi 请求档位；Pi 负责内部回退，Native Session 创建后显示实际值。
- [多个请求档位映射到同一个 Provider 参数] -> 不宣称档位对应远端原生强度；该抽象由 Pi 拥有。
- [Pi Model reasoning 元数据缺失] -> inspection 返回协议错误，不猜测。
- [旧 Pi 缺少 Thinking discovery] -> 返回空 Thinking Catalog并关闭选择能力。
- [首次创建时请求值被回退] -> 在 `turn.started` 前发布 Pi 状态；不由 codexhost 实现 clamp。
- [私有 Renderer 结构漂移] -> 保留版本检查和 fail-closed 行为；新 Desktop build需重新 Gate。
- [Catalog 随项目配置变化] -> Catalog 限于当前 Host/cwd进程，显式 refresh重新检查；不持久化。

## 迁移计划

1. Pi available Model 私有结构增加严格 `reasoning` 解析。
2. Catalog normalization 为所有 Model 生成静态支持关系，并保留旧 Pi 能力降级。
3. 删除 Harness inspection 目标 Model 参数和 Renderer Draft 目标检查。
4. Draft Model 选择只更新内存状态、carrier 和 prewarm。
5. 保留 Existing Thread、首次 Turn、恢复/Fork 的 Pi 状态读取。
6. 更新契约、Adapter、Renderer 测试和验证文档。
7. 执行 TypeScript、lint、聚焦测试、strict OpenSpec validation 和 diff 检查；对新 Desktop build分别记录注入readiness与真实交互Gate，不得用前者代替后者。

回滚时可以恢复逐目标 Model inspection，而 carrier、Native Session 状态、Host 固定方法和持久化格式无需迁移。
