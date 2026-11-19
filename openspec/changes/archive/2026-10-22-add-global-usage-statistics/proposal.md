## Why

`add-host-usage-metering` 让单个外部 Harness 会话有了统一口径的 Token、缓存命中与费用，但用户看不到“这台机器上所有 Harness、所有会话一共用了多少、值多少钱”。该变更已把这项能力列为独立功能（其 proposal Non-Goals），并把三件事留给它：跨会话加总的去重、子代理费用、读取本地会话文件。

直接把各会话的单会话结果相加是错的。本机实测（只读扫描，2026-10-05）：

- Pi：1924 个会话文件中 682 个是分叉，分叉文件复制父会话的全部历史。按文件相加，输出 Token 比按请求 ID 去重后多 **143.6%**（148261 条带用量的助手消息，去重后 60527 条）。
- OMP：149 个文件，按文件相加多 **107.0%**（1403 条 → 833 条），同样来自分叉。
- Claude Code：224 个主会话文件，按文件相加多 **34%**（输出 1046 万 → 781 万）；另有 9 个子代理文件。

本机原生会话数据量也不小：Pi 2.7 GB、Codex 1.6 GB、Grok 1.3 GB、Hermes 677 MB、Claude Code 551 MB。每次打开页面全量解析不可行，需要增量。


## What Changes

做法见 `design.md`：

- 新增可选 Adapter 能力：只读本机原生会话存储（文件或数据库，不启动原生进程、不写入），按原生分叉规则排除复制的历史，返回统一口径的用量记录（含原生时间戳、模型、记录 ID），支持对只增长的文件从上次位置继续读。原生格式只在各 Adapter 内。
- 官方 Codex 由独立的 `codex-usage` 统计插件读取（原生请求记录与累计计数配对、分段合并、归档副本、压缩与子代理边界）。插件无需提供聊天、分叉或恢复操作，不依赖 Desktop；Host 不内置 Codex 存储知识。
- Host 汇总：按筛选条件（范围、Harness、模型、项目、日期）聚合；按（来源, 记录 ID）兜底去重；读时按价格目录以模型 ID 计价，补价即更正历史。解析结果按文件指纹缓存于 Host 数据目录，可删除、可重建。
- 刷新：Host 启动后后台预热；页面先拿缓存结果，过期后台重读；首次读取显示进度。不做定时扫描。
- 设置页“用量统计”（控制台与 Desktop 共用）：今天 / 7 / 30 / 90 天 / 全部；可按 Harness、模型、项目与某一天筛选；总览（费用、Token 用量（不含缓存读写）、缓存命中率）；趋势、按时段；按 Harness、模型、项目分解；最耗会话、最近会话；未计价模型提示并可直接补价；导出 CSV。
- 复用已完成的按模型 ID 自定义价格，不新增第二套价格或账本。

## Non-Goals

- 不统计实际账单、订阅扣款或 credits；费用只表示“按官方公开价相当于多少”。
- 不按服务商定价，不做服务商倍率或通配价格；只按模型 ID 匹配。
- 不改写、删除、迁移原生会话；不做会话管理（删除、回收站、换服务商）。
- 不做工具与技能调用、活跃时长统计。
- 不做网关或代理侧逐请求记录。
- 不做远程 Host 汇总或跨机器合并；每个 Host 只统计所在机器。
- 不做 OTLP、Langfuse 等外发（本地 CSV 导出除外）。

## Capabilities

### New Capabilities

- `global-usage-statistics`：本机全局用量统计（只读用量读取能力、Host 汇总与读时计价、设置页展示）。

### Modified Capabilities

None（发生时间由新能力返回，不修改 `harness-session-usage-telemetry`）。

## Impact

- `packages/harness-adapter`：新增可选能力接口（只读用量读取）。
- 各 Adapter：实现读取器；尽量复用已有的 `*UsageHistory` / `*UsageRecord` 纯函数。
- `packages/adapters/codex-usage`：只读官方 Codex 原生用量的独立插件。
- `packages/host-runtime`：通过公共加载器接收会话插件或仅统计插件；汇总、去重、增量缓存与预热、读时计价、Host 方法。
- `packages/shared-contracts`：统计结果 schema 与方法名；加入控制台方法白名单。
- `packages/renderer-extension`：设置页“用量统计”。
- `docs/product/usage-metering.md`（或新建全局统计文档）。
