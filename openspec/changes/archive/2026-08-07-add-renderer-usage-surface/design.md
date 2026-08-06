## Context

`HostUsage` 已经由 Harness Adapter 归一化，并由 `ExternalThreadRuntime` 按 Thread 保留最新快照。当前 Host 只把可投影的上下文字段转成 Codex 原生 `thread/tokenUsage/updated`，因此原生上下文圆圈可以更新，但 Renderer Extension 无法读取 CH、成本或缓存明细。

本 Change 新增一个受限的 Renderer-facing Thread Usage 快照读取，并在 Composer 中增加自有 Usage 控件。当前 Desktop 的稳定扩展边界是 Composer DOM、Host request manager 和现有 `thread/inspect` 请求；不依赖修改 Codex React 状态，也不改原生上下文控件。

## Goals / Non-Goals

**Goals:**

- 在原生上下文圆圈左侧显示紧凑的 `CH` 与累计成本摘要。
- 点击摘要显示当前线程可用的 Usage 明细。
- 通过 Thread ID 绑定快照，在线程切换和 Composer replacement 时避免串数据。
- 初始恢复读取和原生上下文圆圈更新后的刷新都使用 Host 的最新内存快照。
- 保持原生上下文圆圈和 `thread/tokenUsage/updated` wire shape 不变。

**Non-Goals:**

- 不修改原生上下文圆圈、原生 Model 控件或 Codex React 状态。
- 不持久化 Usage、成本、缓存命中率或 Usage timeline。
- 不创建通用 Host Request API；Renderer 只能调用固定的 Thread Usage inspection。
- 不承诺每个 Token 到达时刷新；Usage 仍按 Harness 的可靠快照边界更新。
- 不展示无法由当前 Harness 提供的字段，不以零值代替未知值。

## Decisions

### 1. 使用浏览器安全的专用 Usage 快照类型

在 `shared-contracts` 定义严格的 `threadUsageSnapshotSchema`，字段与已归一化的 `HostUsage` 对齐，但不让浏览器包依赖 `harness-adapter`。只允许非负安全整数、有限非负成本和 0 到 100 的 CH，未知字段保持缺失。

Renderer 通过现有 `thread/inspect` 响应获得初始快照。这样不增加通用查询，也不需要把 Node-only Harness 类型引入浏览器构建。

### 2. 使用固定的 `codexhost/thread/usage/inspect` 请求刷新

新增固定请求方法 `codexhost/thread/usage/inspect`，参数只有 `threadId`，返回 `{ threadId, usage }`。Host 只对已加载的 External Thread 返回当前内存快照，官方 Codex Thread 或不存在的 Thread 返回 `null`/明确的不可用结果。

Renderer 初始 Thread ownership inspection 同时获得 Usage；原生上下文圆圈发生变化时，Renderer 以受控、去抖的单次查询刷新 Usage。查询结果必须再次校验 Thread ID 和当前 Composer generation，过期结果直接丢弃。

不使用轮询器或任意 Host method。Usage 的事实来源仍是 `session.usage.changed` 和 Host Runtime 的 `latestUsage`。

### 3. Usage 控件作为原生控件左侧 sibling

`renderer-composer-dom` 新增 Usage control 的挂载和销毁逻辑。挂载时优先识别当前 Composer 中语义明确的原生 context usage control，并将 codexhost root 插入其父节点的前面；原生节点本身不写入任何属性和样式。

如果当前 Desktop build 没有可验证的 context anchor，Usage control 不挂载，而不是猜测 toolbar 子元素位置。这样可避免升级后把控件插入错误位置。控件使用独立的 `data-codexhost-usage-control` 标记，并使用现有 Renderer 控件的 inline style 约定。

### 4. 折叠摘要与详情 Popover 分离数据范围

摘要只显示当前可靠的 `CH` 和累计成本：

```text
CH 99.9% · $0.168
```

详情 Popover 显示上下文、缓存读取/写入、输入/输出 Token 和成本。每项只在字段存在时显示；CH 标注为最近一次请求，成本标注为 Session 估算累计值。Usage 为 `null` 或没有可显示字段时，整个控件隐藏。

### 5. Host 不扩展原生 Codex Usage carrier

`projectCodexThreadUsage` 保持原有字段和语义，不加入成本或 CH。Renderer Usage 只通过专用、严格校验的 Host projection 读取。这样原生上下文圆圈仍只表示上下文使用量，且不会把协议 carrier 的占位 Token 误认为真实成本或缓存数据。

## Risks / Trade-offs

- [不同 Desktop build 的上下文圆圈 DOM 结构变化] -> 只接受唯一、语义可验证的 anchor；无法识别时 fail closed，并保留原生 UI。
- [刷新查询晚于 Thread 切换返回] -> 使用 Thread ID、Composer identity 和 request generation 三重校验。
- [Usage 只有成本或 CH 没有上下文字段] -> 允许通过专用查询展示可用摘要，但不触发或伪造原生上下文圆圈数据。
- [摘要宽度随成本变化导致 toolbar 跳动] -> 为摘要预留稳定最小宽度并使用等宽数字；详情内容不影响 toolbar 尺寸。
- [Usage 查询失败影响正常对话] -> 查询失败只隐藏或保留最近可靠的 Renderer 状态，不改变 Turn、Session 或 Agent routing。

## Migration Plan

1. 增加 shared contract 快照和固定 inspection 方法。
2. 在 Host inspection 路径返回当前 External Thread Usage，并增加 Host 测试。
3. 在 Renderer 增加 Usage control、anchor detection、Popover 和 Thread generation 绑定。
4. 增加 Renderer DOM、contract、Host 查询和刷新行为测试。
5. 运行格式化、类型检查、聚焦测试和 Renderer build；真实 Desktop Gate 确认控件位于原生上下文圆圈左侧且原生圆圈未被修改。

回滚时删除 Renderer Usage control 和固定 inspection 路由即可；不会触碰 Harness Usage producer、Mapping Store 或原生 Token Usage 投影。
