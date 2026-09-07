# Hermes 会话生命周期修复设计

## 目标

修复 CodexHost 中 Hermes 的五类遗留问题：真实默认模型识别、创建失败错误透传、创建失败回滚、取消后侧栏状态残留、会话创建等待过长；并把 Hermes 纳入正式插件构建与回归测试。

## 明确不做

- 不处理 MiniMax-M3，不安装 `anthropic`，不修改 Hermes 认证或模型依赖。
- 不删除现有 Hermes 历史空会话，不修改 `~/.hermes/state.db`。
- 不为提高速度维护 Hermes 私有源码分叉。
- 不改变其他 Harness 的模型、创建或取消语义。

## 现状与根因

1. `hermes-inventory.ts` 的只读探测只输出模型行，丢失 Hermes 配置中的当前 provider/model；CodexHost 随后把目录第一项误当默认模型。
2. ACP JSON-RPC 错误的 `data.details` 没被 `classifyStartupError()` 提取，用户只看到 `Internal error` 或通用启动失败。
3. `HermesAdapter.open()` 先创建并持久化原生 session，再调用 `session/set_model`。Hermes ACP 当前没有公开 session delete 方法，不能安全地由 CodexHost 删除原生空 session；Host 侧的 provisional mapping 已在失败时回滚。
4. Hermes 取消已返回 `stopReason=cancelled`，Adapter 也发出 `turn.completed`；Host 原先先发 terminal turn、后发 idle，与 Codex Desktop 的原生生命周期顺序相反，导致已中断 turn 可能留下侧栏 spinner。
5. 每个 Hermes session 都新建 ACP 进程；显式选模还会在 `session/new` 后重建一次 Agent，导致创建时间进一步增加。

## 方案

### 模型目录与默认值

库存探测同时返回 `currentProvider`、`currentModel` 和模型列表，并编码成与目录相同的原生选择 ID。只有真实当前模型存在时才设置 `defaultModel`；无法识别时不伪造默认值。

### 错误透传

Adapter 只负责把 Hermes ACP 错误规范化为 Harness 错误，不隐藏原始可操作细节。错误提取顺序为：JSON-RPC `data.details`、JSON-RPC message、普通 Error message、字符串兜底；对 UI 仍保留稳定错误码。

### 创建事务边界

创建失败时保持 CodexHost provisional mapping 回滚，并关闭当次 transport。不直接修改 `~/.hermes/state.db`，也不调用 Hermes 未公开的私有删除函数；因此“创建成功、选模失败”仍可能在 Hermes 原生库留下空 session。这是明确的上游 ACP 能力边界，不用破坏性数据操作伪装修复。

### 取消终态

Host 对每个非临时 `turn.completed` 做终态收口：先清除 `running`/`activeTurnId` 并发布 `thread/status/changed=idle`，再发布 terminal turn。这与 Codex app-server 原生顺序一致，Renderer 无需再维护一套 Hermes 专用运行态。

### 创建性能

第一阶段只在 CodexHost 内优化：按 cwd 保留一个已 initialize 的备用 ACP transport。`inspect` 完成后保留当前 transport 给第一次 open；每次 open 成功后异步补齐下一个备用进程。各会话仍使用独立进程，避免多 session 回调串线。当用户所选模型已是 `session/new` 返回的当前模型时，跳过 `session/set_model`，避免无意义的 Agent 重建。

### 构建发布

Hermes 加入 `scripts/release/harness-plugins.json`，修复相关类型测试，并验证构建产物能被 Host 的已安装插件加载器识别。

## 验收标准

- 模型按钮显示并实际使用真实的 `Provider / model`；不再把目录第一项伪装成默认值。
- 创建失败展示 Hermes 返回的具体原因，并且不会新增 CodexHost 映射；Hermes 原生空 session 限制如上。
- 点击停止后，主区域和左侧会话列表都在终态通知完成后停止运行态显示。
- 第二次及后续新建 Hermes 会话不再重复承担 ACP 进程冷启动成本；记录冷启动、热启动和显式选模耗时。
- Hermes 插件正式构建、Focused tests、TypeScript typecheck、lint 通过；若仓库已有失败，必须区分基线和本轮回归。

## 安全与回滚

- 所有代码修改位于独立分支 `fix/hermes-lifecycle`。
- 不清理用户历史数据；新建失败只回滚 CodexHost 本轮 provisional mapping。
- 安装 App 前保留现有 renderer/plugin 备份；安装动作使用已有已授权复制路径。
