## Why

当前 Claude Code Adapter 只能报告安装可用，仍返回空 Model Catalog 并拒绝 Model/Thinking 选择；Renderer 因而无法显示用户当前 Claude Code 配置实际解析出的官方 Claude、Bedrock、GLM、MiniMax 或其他兼容模型。官方 Agent SDK `0.3.220` 已提供无 Prompt 初始化目录、Session 级 Model setter 和稳定的实际 Model 回读，受控本地验证也证明这些操作无需创建 Native Session，因此现在可以沿用现有 Harness Model 契约补齐 Claude，而不读取 `settings.json`、维护静态 Claude manifest 或猜测 Provider 能力。

## What Changes

- 让 Claude Code Adapter 通过用户安装的 Claude Code 和官方 Agent SDK 初始化结果读取当前 cwd/config/policy 下的可选 Model 与 effort 元数据，并在 inspection 完成前有界关闭临时进程；Host composition 启动后非阻塞预取一次并复用相同的进程内缓存。
- 明确区分 Adapter-owned selectable Model Ref、Claude Code 动态别名和 SDK 回读的 runtime-resolved Model；`default` 保持“跟随 Claude Code 默认策略”语义，不固化为某个模型。
- 支持 Claude create-time Model 请求和 Idle Session Model 控制，所有成功状态以稳定结构化 readback 为准；无法证明实际状态时不得声称切换成功。
- 将有限外部 transport configuration carrier 从 Pi 专用扩展到 Claude Code，使每个 Composer 的 Claude Model 请求与精确 `thread/start` 绑定，不引入进程级 pending selection。
- 将现有 codexhost Model 控件从 Pi 专用行为泛化为 capability-driven external Harness 行为，同时保持 Codex 官方 Model picker、用户默认配置和 title/usage 路径不变；SDK effort 元数据可以规范化进入 Catalog，但本 Change 不开放 Claude Thinking 选择。
- 增加普通 Hermetic 覆盖和显式无 Prompt/真实 Desktop Gate；普通检查不得启动 Claude、读取用户配置或访问模型网络。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `shared-runtime-contracts`: 扩展严格浏览器安全 Model 状态，表达可重放选择与 runtime-resolved Model 观察而不暴露 Native 配置。
- `harness-model-catalog`: 将实际 Model readback、动态别名和 capability-driven Model 控制纳入通用 Catalog/Session 语义。
- `claude-code-text-session`: 将 Claude inspection 从安装-only空目录升级为官方 SDK runtime Catalog、create/Idle Model 选择和实际状态回读，同时保持 Thinking 选择关闭。
- `registered-harness-routing`: 为 Claude Code 解码有界 Model/Thinking carrier，并继续通过通用 HarnessSession 控制与状态路径路由。
- `versioned-renderer-agent-routing`: 为 Claude Composer 和现有 Claude Thread 启用现有 Model/Thinking 交互，同时保持 Agent/Model/Provider 语义隔离和 fail-closed 行为。

## Impact

- 影响 `packages/shared-contracts`、`packages/harness-adapter`、`packages/adapters/claude-code`、`packages/protocol-core`、`packages/host-runtime` 和 `packages/renderer-extension` 的契约、实现与聚焦测试；Claude Thinking 写入与实际档位回读不在本 Change 范围。
- Claude inspection 将在 Host composition 启动后后台启动一个不发送 Prompt 的临时用户 Claude Code 进程；结果限于进程内缓存，失败不缓存，不持久化 Catalog 或第二份配置，且 Codex/Pi 启动不等待该结果。
- 不新增依赖，不修改或写入 `~/.claude/settings.json`，不持久化 Provider、base URL、价格、认证、账户或原始 SDK payload。
- 不改变 Pi Model/Thinking 语义、官方 Codex Model 路由、Mapping Store 格式、Claude executable 分发策略或模型可调用性承诺。
