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
3. `HermesAdapter.open()` 先创建并持久化原生 session，再调用 `session/set_model`。后者失败时仅关闭进程，不删除本次新 session。
4. Hermes 取消已返回 `stopReason=cancelled`，Adapter 也发出 `turn.completed`；问题位于 Host/Renderer 的终态通知和侧栏状态对账。
5. 每个 Hermes session 都新建 ACP 进程；显式选模还会在 `session/new` 后重建一次 Agent，导致创建时间进一步增加。

## 方案

### 模型目录与默认值

库存探测同时返回 `currentProvider`、`currentModel` 和模型列表，并编码成与目录相同的原生选择 ID。只有真实当前模型存在时才设置 `defaultModel`；无法识别时不伪造默认值。

### 错误透传

Adapter 只负责把 Hermes ACP 错误规范化为 Harness 错误，不隐藏原始可操作细节。错误提取顺序为：JSON-RPC `data.details`、JSON-RPC message、普通 Error message、字符串兜底；对 UI 仍保留稳定错误码。

### 创建事务与回滚

创建并选模视为一个事务。仅 `kind=create` 且后续初始化失败时，调用 Hermes 原生 session 删除能力清理本次创建的 session；resume/fork 永不删除。清理失败只能作为诊断信息，不能覆盖主错误。

### 取消终态

Host 对每个非临时 `turn.completed` 做幂等终态收口：先清除 `running`/`activeTurnId`，再投影 turn，最后发布 `thread/status/changed=idle`。即使投影通知失败，也必须在 finally 路径尝试发布 idle。Renderer 收到 terminal turn 或 idle 状态任一事件时，都清理本地运行态，防止通知乱序留下 spinner。

### 创建性能

第一阶段只在 CodexHost 内优化：复用 Adapter 级 Hermes ACP 进程并允许同一连接管理多个空闲 session，避免每次重复 Python/ACP 启动；session 的 prompt、cancel、permission 回调仍按 sessionId 隔离。显式选模的 Hermes Agent 二次初始化属于原生 ACP 行为，本轮不改 Hermes 源码。验收以真实计时为准，不承诺无法由 CodexHost 控制的耗时。

### 构建发布

Hermes 加入 `scripts/release/harness-plugins.json`，修复相关类型测试，并验证构建产物能被 Host 的已安装插件加载器识别。

## 验收标准

- 模型按钮显示并实际使用真实的 `Provider / model`；不再把目录第一项伪装成默认值。
- 创建失败展示 Hermes 返回的具体原因，并且不会新增本轮失败产生的空 session 映射。
- 点击停止后，主区域和左侧会话列表都在终态通知完成后停止运行态显示。
- 第二次及后续新建 Hermes 会话不再重复承担 ACP 进程冷启动成本；记录冷启动、热启动和显式选模耗时。
- Hermes 插件正式构建、Focused tests、TypeScript typecheck、lint 通过；若仓库已有失败，必须区分基线和本轮回归。

## 安全与回滚

- 所有代码修改位于独立分支 `fix/hermes-lifecycle`。
- 不清理用户历史数据；新建失败只回滚本次生成的原生 session。
- 安装 App 前保留现有 renderer/plugin 备份；安装动作使用已有已授权复制路径。

