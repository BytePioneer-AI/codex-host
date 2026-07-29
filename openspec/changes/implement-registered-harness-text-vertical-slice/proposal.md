## Why

Claude Code的真实Agent SDK语义已经通过Gate，但当前Host和Renderer组合仍把唯一外部Harness硬编码为Pi，因此尚不能证明第二个具体Adapter能够复用同一HarnessSession、Protocol Core Projector和Codex Desktop创建链路。现在需要一个开发期最小文本纵向切片，验证架构的注册式扩展能力，而不是为Claude建立旁路或提前改变Pi公开MVP范围。

## What Changes

- 新增`@codexhost/adapter-claude-code`，使用官方Agent SDK和用户安装的Claude Code实现惰性create、流式text turn、active turn cancel、Session Fault和有界close。
- 将Protocol Core的单一Pi transport token解码扩展为有限的已注册外部Harness路由，同时保持官方Codex Model透明转发。
- 将Host Runtime的`PiThread/#piAdapter`组合层泛化为外部Harness注册表和统一Thread所有权；Pi和Claude Code均通过相同HarnessAdapter接口、响应Gate和Codex UI Projector运行。
- 扩展Renderer Agent状态和版本Adapter，使受控开发Gate可以显式启用Claude Code并写入其transport token；默认构建和默认Probe仍只展示Codex/Pi。
- 增加Fake双Adapter契约、Claude Adapter Hermetic/Live测试以及真实Codex Desktop人工验收入口。
- 不增加Claude原生协议到Host/Renderer，不实现Mapping Store、历史恢复、Fork、Tool/Interaction UI、发布打包或公开Claude产品支持。

## Capabilities

### New Capabilities

- `claude-code-text-session`: 官方Claude Agent SDK到现有HarnessAdapter text/cancel/fault/close语义的具体Adapter实现与真实能力验证。
- `registered-harness-routing`: Protocol Core和Host Runtime通过有限注册表路由多个外部Harness，并复用统一Codex UI投影和Thread生命周期。

### Modified Capabilities

- `versioned-renderer-agent-routing`: 受支持Renderer Adapter可在显式开发配置下选择已注册的Claude Code Agent并携带独立transport token，同时保持默认Codex/Pi集合和fail-closed行为。

## Impact

- 新增`packages/adapters/claude-code/`及官方Claude Agent SDK生产依赖。
- 修改`packages/protocol-core`的create-route解码、`packages/host-runtime`的组合与资源所有权、`packages/renderer-extension`的Agent配置和受控Probe。
- 修改根TypeScript Project References、workspace锁文件、边界测试和开发Gate命令。
- 默认Codex/Pi路由、Pi Tool/Cancel语义、Mapping Store、Renderer公开范围和发布产物保持不变。
