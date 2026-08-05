## Why

Codex Desktop `26.727.40816` 已提供最后一条用户消息的铅笔入口，并固定发送 `thread/rollback { numTurns: 1 }` 后再执行修改后的 `turn/start`；当前 codexhost 只接受 untouched Fork-derived External Thread 的 rollback，导致普通 Pi Thread 在进入 Adapter 前失败。需要补齐这条后端能力，同时保持 Desktop 原生 UI 和现有 Fork 行为不变。

## What Changes

- 让支持该能力的 ready External Thread 接受仅限 `numTurns=1` 的最后一轮 rollback，成功后保持 Host Thread ID，并返回删除最后一轮后的完整 Thread。
- 为 HarnessAdapter 增加窄化的“派生当前 Native Session 去掉最后一轮后的独立 Native Session”能力；首轮被删除时允许空历史，并保持当前 Native Session 已确认的 Model 和 Thinking 配置。
- 由 PiAdapter 使用 Pi 结构化原生能力实现该派生，验证输入 Session 不变、目标 Session 身份不同、历史恰好少一轮且当前配置一致。
- 由 Mapping Store 原子替换同一 ready Thread 的 Native Session 和精确短一轮 Turn mappings；失败时旧记录和旧 Runtime 继续有效。
- 将最后一轮 rollback 作为当前 External Thread 的独立操作，不要求 `forkSource` 或来源 Checkpoint；现有 `thread/fork` 和 post-Fork rollback 行为保持独立且不变。
- 普通 External 多轮 rollback、任意历史消息 Rewind 和 Claude Code 支持不在本 Change 范围内。
- 复用 Codex Desktop 现有铅笔、Composer 回填和重新发送流程，不修改 Renderer Extension，不回滚或复制项目文件。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `harness-adapter-history-fork-session`: 增加诚实的最后一轮 Native Session 派生能力及空历史结果语义。
- `external-thread-fork-routing`: 接管当前 ready External Thread 的直接单轮 rollback，并与既有 Fork 路由保持独立。
- `external-thread-mapping-store`: 增加 ready Thread 的原子最后一轮 Session 替换，并允许零 Turn mappings。
- `pi-model-routed-vertical-slice`: 让 Pi 原生派生 Session 精确排除当前最后一个 User Turn。

## Impact

- 公共契约：`packages/shared-contracts`、`packages/harness-adapter` 增加一个布尔历史能力和一个窄化 Session open mode；现有 Fork 契约不变。
- Runtime 与持久化：`packages/host-runtime`、`packages/mapping-store` 增加单轮 rollback 路由、验证和原子替换。
- Pi：`packages/adapters/pi` 增加最后一轮之前的原生历史派生；Claude Code 明确报告不支持。
- Protocol Core 继续使用现有 `thread/rollback` 解码和响应形状；Renderer Extension、Desktop Control、Mapping Store V1 字段和项目文件均不改变。
