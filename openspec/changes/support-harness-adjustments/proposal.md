## Why

用户需要在外部 Harness 执行期间提交修正指令。现有实现仅对精确验证的 OpenCode 开放同 Turn steering，其他 Harness 的取消与后续输入能力尚未形成可用的调整流程。

## What Changes

- 保留同 Turn 的 `turn.steer` 契约，并增加按 Session 能力选择原生 steering 或中断续发的公共调整流程。
- 中断续发保留旧 Turn 和工作区修改，在原生执行收敛后建立新的 Host Turn。
- 覆盖请求去重、连续调整、取消与自然完成竞态、失败、输出顺序和历史恢复。
- 按 Adapter 的可靠能力开放调整，使用原生接口与明确的版本/状态约束。
- 核对 #155 的 DeepSeek rollback 实现与调整后历史的兼容性；运行中调整不执行历史回滚。

## Capabilities

### New Capabilities

- `harness-turn-adjustment`: 外部 Harness 运行中调整的能力选择、生命周期、消息确认和恢复契约。

### Modified Capabilities

无；原有同 Turn steering 和历史替换的安全要求继续适用。

## Impact

涉及 shared-contracts、harness-adapter、host-runtime、必要的 Desktop 桥接及各 Harness Adapter 和聚焦测试。基于 PR #158，不修改原生 Codex 的路由与协议，不增加依赖。
