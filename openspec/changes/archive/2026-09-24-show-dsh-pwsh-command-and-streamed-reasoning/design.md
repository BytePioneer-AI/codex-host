## Context

DSH 的 `tool/call` 保存 `name: "pwsh"` 和 JSON 字符串参数 `command`，Adapter 已把它作为通用 Tool 交给 Protocol Core。Protocol Core 只识别 `powershell` 等命令名，因此 Desktop 收到只显示名称的通用卡片。DSH `reasoning-delta` 可在持久化 `assistant/message` 前到达，也可能在块结束或重试时被修订；当前 Adapter 忽略增量并在最终消息中创建 Reasoning Item。Protocol Core 已支持 Reasoning 的追加与可查看的文本承载。

## Goals / Non-Goals

**Goals:** 在现有命令框中显示完整 `pwsh` 命令；实时显示原生可见思考；修订、取消、重连和冷恢复后保持 Item 生命周期与权威历史一致。

**Non-Goals:** 增加新的 Renderer 面板、公开 DSH wire 类型、推断未出现的思考或把临时思考写入 Host 持久化数据。

## Decisions

1. 在 Protocol Core 现有 `toolCommandLine` 识别名单中加入 `pwsh`。仅当原生参数含非空命令时生成 `commandExecution`；无可用命令仍走通用 Tool，不猜测脚本。
2. Adapter 按原生 `reasoning-delta` 向 Host Reasoning Item 追加文本。V3/V4 临时 Item 使用 attempt ID 与最终 Item 分离，避免重试重用 Item ID；V0 使用持久化 chunk 的现有步骤 ID。
3. 原生 `assistant/message` 决定最终思考：若临时文本是最终文本的前缀，只追加差值并完成原 Item；若被修订或删除，先取消临时 Item，再以新的 Item 发布最终文本。放弃、失败结算或重连后失去原生尝试时也取消临时 Item。Host 只追加，不发伪造的替换更新。
4. 历史仍由 `readSnapshot()` 从 DSH 持久化事件重建；重连按现有 baseline 和 settlement 去重，不能重复播放已投影增量。测试分别覆盖 V0 durable chunk、V3/V4 transient frame、修订和恢复。

## Risks / Trade-offs

- 临时思考可能被原生修订：旧 Item 将保留为明确取消的实时记录；冷恢复只显示最终原生思考。
- 原生模型可能没有输出可见思考：保持无 Reasoning Item，不根据 token 计数生成文本。
- Desktop 的命令框外观由客户端控制：通过既有 `commandExecution` 契约提供完整命令和输出，不修改 Desktop 私有 UI。
