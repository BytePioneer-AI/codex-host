---
name: codexhost-add-harness
description: 为 codexhost 新增或规划外部 Harness 接入。当需要实现、初始化、审查或补全 Harness Adapter，注册新的编码 Agent，或者检查新 Harness 必须支持哪些 codexhost 公共能力时使用。应先读取仓库中的当前接口；本 Skill 的参考文档是能力检查清单，不是接口定义副本。
---

# 新增 codexhost Harness

实际可行时，优先使用 Agent 的原生 SDK、RPC 或其他原生接口，而不是 ACP；ACP 可能导致部分能力无法实现，或者显著增加实现复杂度。

通过 codexhost 已有的 Harness seam 完成接入。公共 Adapter 和 Session 接口能够表达的 Host 能力，不得创建 Harness 专用实现路径。

## 从当前接口开始

规划或修改代码前，读取：

- `packages/harness-adapter/src/index.ts`
- `packages/harness-adapter/src/text-session.ts`
- `packages/shared-contracts/src/harness-models.ts`
- 涉及 Permission Mode 时读取 `packages/shared-contracts/src/harness-permission-modes.ts`
- `packages/protocol-core/src/model-routing.ts`
- `packages/harness-adapter/src/plugin.ts`
- `packages/host-runtime/src/harness-plugin-loader.ts`
- `docs/harness-plugin-runtime.md`
- `packages/renderer-extension/src/agent-selection-state.ts`
- `packages/renderer-extension/src/versioned-renderer-adapter.ts`
- [references/current-harness-implementations.md](references/current-harness-implementations.md)
- 根据上述参考文档，按传输方式和目标能力选择至少一个现有 Adapter

以当前仓库源码为权威依据。实现地图用于解释当前架构，并指出各项能力最合适的参考实现；复制模式前必须根据当前源码核实。不要在新 Adapter 中复制公共接口声明，也不要仅凭本 Skill 推断接口。

## 规划接入

按能力选择参考实现，不要完整复制某一个 Adapter。先选择最接近的原生传输模式，再针对每项附加能力读取最合适的实现。

记录原生 Harness 支持和不支持的当前能力，以及每项受支持能力如何映射到公共接口。通过能力声明或类型化的 `unsupported` 错误明确表达不受支持的行为。

根据工作范围读取：

- 所有新增 Harness 都读取 [references/public-adapter-contract.md](references/public-adapter-contract.md)。
- 涉及 Native identity、快照、resume、fork 或 rollback 时，读取 [references/thread-lifecycle-and-history.md](references/thread-lifecycle-and-history.md)。
- 涉及流式消息、Reasoning、工具、文件、Approval、Question、Subagent 或 Autonomous Turn 时，读取 [references/output-and-interactions.md](references/output-and-interactions.md)。
- 涉及包创建、Harness ID、Runtime 注册、release 或测试时，读取 [references/registration-and-validation.md](references/registration-and-validation.md)。
- 只要 Harness 需要出现在 Codex Desktop 的 Agent Picker、创建/恢复 Thread 或显示配置与状态，就读取 [references/renderer-product-integration.md](references/renderer-product-integration.md)。
- 只要 Harness 需要接收其他 Agent 的任务、在自身内部继续委派、支持委派 Thread 的后续消息/取消，或者声明完整 Agent 协调能力，就读取 [references/cross-harness-delegation.md](references/cross-harness-delegation.md)。

宣布完成前，逐项满足所有适用参考文档的要求。某项现有 codexhost 能力没有独立参考文档，不代表可以忽略；应检查受影响范围内的相邻 Adapter、公共契约、测试和注册代码。

## 在公共 seam 后实现

在 `HarnessAdapter` 和 `HarnessSession` 后实现新的原生集成。在所属 Adapter 包内，将原生请求、事件、历史、错误、身份和能力转换为公共契约。

通过 Manifest、插件工厂和显式启用配置接入 Host；发行版预装集合由发行清单管理。保持 Host 对具体 Adapter 包无静态依赖。Renderer 与旧路由尚未完全迁移，按当前源码核对实际产品接入范围。原生协议细节必须留在对应 Adapter 内部。

## 完成接入

完成前确认：

- 实现与声明的能力一致；
- 在原生 Harness 支持的范围内，create、resume、Turn 执行、后续 Turn、取消、事件、快照、错误和关闭行为均已覆盖；
- 声明完整 Agent 协调能力时，Harness inspection、显式及默认配置、持久化恢复、递归委派环境和只读观察均已通过公共 seam 验证；
- 所有适用的能力参考清单均已满足；
- Host、Renderer、Desktop Control、包导出、发布组合、测试和受影响文档保持一致；
- 聚焦测试覆盖公共接口和原生边界情况；
- 任何现有 Harness 都不需要知道新 Harness 的专用信息。

明确报告不受支持的能力和有意推迟的工作。
