## Why

DSH 的 `pwsh` 工具调用目前在 codexhost 中只显示名称，用户无法查看原生命令与输出。DSH 已提供可见的原生思考增量，但 Adapter 等到最终消息才发布思考，导致回合进行中无法查看。

## What Changes

- 将带有有效 `command` 参数的原生 `pwsh` 工具投影到现有可展开命令框，并保留工具原生输出。
- 在 DSH V0/V3/V4 的有效回合中实时发布可见思考增量；原生结算修订或放弃临时内容时明确结束临时 Item，并只以原生最终消息作为历史来源。
- 为命令、流式思考、修订、重试和恢复补充定向回归，更新受影响的 DSH 文档。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-adapter-tool-cancel-session`: 识别可还原完整命令的 `pwsh` 工具，并使用现有命令框显示。
- `harness-reasoning-projection`: 允许 DSH 先显示原生临时思考，在修订或放弃时明确取消旧 Item，再显示权威内容。

## Impact

修改 `packages/protocol-core` 的工具投影和 `packages/adapters/deepseek-harness` 的 Session 思考生命周期；公共 Harness 类型、Renderer 和 DSH 原生协议不变。参考 DSH tag 只读，原生 Session 仍归 DSH 所有。
