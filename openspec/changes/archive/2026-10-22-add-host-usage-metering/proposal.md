## Why

会话用量浮窗里的费用、速度和缓存命中率目前由各 Adapter 自行上报，覆盖率和口径都不一致：

- 只有 DeepSeek（原生）报告输出速度；费用只有约一半 Harness 报告，且各自的价格来源、是否计入缓存都不同。
- 同一个 `inputTokens` 字段在不同 Adapter 中含义不同：Claude Code、Pi、OMP、OpenCode、DeepSeek、Hermes、Kimi 的输入不含缓存；Grok、ZCode、CodeBuddy 的输入包含缓存。OpenCode 的输出不含思考，其他已确认的 Harness 输出包含思考。按错误口径计费会把缓存按全价重复计算。
- `cacheHitRatePercent` 只反映最近一次请求，用户看不到整个会话的缓存效果。
- 已发现的具体缺陷：CodeBuddy/WorkBuddy 使用 DeepSeek 模型时缓存命中写在 `prompt_cache_hit_tokens`，Adapter 读取的 `cache_read_input_tokens` 恒为 0；Claude Code 在 Turn 结束校准时只累加 `modelUsage.inputTokens`（不含缓存），输入 Token 会骤降；Hermes 本地数据库已有缓存 Token，Adapter 只取了百分比。

用户关心的是“这个会话消耗的 Token 值多少钱、生成多快”。这些指标可以由 Host 统一、一致地计算。难点不在公式，而在证明统计完整、模型归属正确且没有重复。

## What Changes

- 新增可选的 Adapter 输出事件 `usage.request`：每次原生模型请求完成后，Adapter 按统一口径发布一条请求用量记录，带稳定请求 ID、实际模型 ID（可选服务商）、各项 Token（已知为零的缓存显式填 0，缺失即未知）以及 Adapter 关联测得的输出开始与完成时间。无法证明模型归属的合计增量不带模型，只计 Token。
- 新增 Adapter 输出事件 `usage.history`：打开会话时按原生历史回放全部请求后发布，声明历史是否完整；运行中发现用量缺口时再次声明不完整。分叉、撤销等不做特殊处理：原生历史里有什么就计什么。
- Host 新增 Usage 计量（仅内存）：按请求 ID 去重累加，计算会话累计费用、会话平均缓存命中率、最近一轮首字延迟（Host 观测）、按请求计时的回合平均输出速度。费用和平均缓存命中率只在历史完整时发布。不覆盖 Adapter 上报的原生 Token 累计字段。
- **BREAKING（行为）**：接入 `usage.request` 的 Thread，费用改由 Host 按 Token × 公开价格计算，不再使用 Harness 原生费用；`HostUsage` 新增 `costSource` 区分“按公开价格计算”与“Harness 上报”。
- 新增价格表：随版本打包 models.dev 快照；Host 启动时及运行中每小时检查，本地价格表超过 24 小时则后台刷新，遇到无价格模型时最早 6 小时后提前刷新，失败静默沿用；用户可用数据目录中的 JSON 覆盖或补充。按模型 ID 匹配（含去日期后缀、去推理强度后缀、版本号点号/短横线互换等固定写法），不做模糊匹配；费用每次按当前价格表重算。
- `HostUsage` 与 Thread Usage 契约新增 `sessionCacheHitRatePercent`、`timeToFirstOutputMs`、`costSource`。用量浮窗新增对应两行，并按费用来源说明计算方式。
- 第一批只接入 Pi、OMP、OpenCode v2（OpenCode v1 协议不接入，保持原生费用），完整验证创建、恢复、分叉、换模型、重复事件。Claude Code、CodeBuddy/WorkBuddy、DeepSeek、Kimi、Qoder 及其已知缺陷在后续批次处理；Grok、ZCode、Hermes 等合计型或模型归属不明确的放最后。Cursor CLI、Kiro 没有 Token 数据，不支持。

## Non-Goals

- 设置中的全局用量统计页（读取本地会话文件）是独立功能，不在本变更内。
- 不做实时输出速度：Host 观测的流式事件不携带 Token 数，规范禁止按文本长度估算。
- 不处理非流式 Harness；不新增上下文指标。
- 不区分订阅与按量用户；不计入按次收费（如联网搜索）和长上下文分档价格。
- 不做模型名模糊匹配；不接入 LiteLLM 备用价格源；不提供价格编辑界面。
- 不持久化用量账本；不改变 Codex 原生 Thread 的用量路径。
- 父会话费用不包含子代理的花费，也不包含原生不给出模型的后台请求（如 OpenCode v2 的标题生成与压缩）。
- 分叉与撤销上一轮不做特殊处理：分叉会话的费用包含其原生历史中复制自父会话的轮次；撤销后按剩余原生历史显示，被撤销轮次的花费不再计入。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-session-usage-telemetry`：允许 Host 维护内存计量状态并依据请求记录、价格表与输出事件时间推导派生指标；新增 `usage.request`、`usage.history` 事件与统一 Token 口径；新增三个 Usage 字段。

## Impact

- `packages/harness-adapter`：新增两个输出事件类型与校验；`HostUsage` 新增三个字段。
- `packages/shared-contracts`：Thread Usage 快照新增三个可选字段。
- `packages/host-runtime`：新增价格表模块（快照、刷新、用户覆盖）与 Usage 计量模块，在 External Thread 事件处理处接入。
- Adapters（第一批）：Pi、OMP、OpenCode v2。
- `packages/harness-broker`：事件白名单加入 `usage.request`、`usage.history`。
- `packages/renderer-extension`：用量浮窗新增两行与费用来源说明。
- 构建：新增价格表快照生成脚本与打包资源。
- 网络：Host 正常每 24 小时至多一次请求 `https://models.dev/api.json`；存在无价格模型时最多每 6 小时一次。
