# Grok 原生提问

Grok Adapter 通过 ACP Client 的 `extMethod` 接收 `_x.ai/ask_user_question`，转换为公共 `HostQuestionInteraction`。这与 `session/request_permission` 审批是两条独立通道；审批响应不能回答问题。未知扩展方法仍返回 Method not found，非法提问参数返回 Invalid params。

## 问题与答案

原生请求包含 `sessionId`、`toolCallId`、`mode`（`default` 或 `plan`）和非空 `questions`。问题包含唯一的 `question` 文本、`options`（`label`、`description`、可选 `preview`），可选 `multiSelect` / `multi_select`。两个多选标记冲突、重复问题文本或重复选项标签都会拒绝。

- 有选项的问题映射为 choice，支持 Other；没有选项的问题映射为普通非 secret 文本。
- `multiple: true` 的问题组使用[公共多选卡片](../../architecture/harness-questions.md)，整组一起回答；纯单选或纯文本组保留原生 Desktop 提问卡片。
- 公共答案 ID 为 `q0`、`q1` 等；原生答案以**原问题文本**为键、**原选项标签数组**为值，不使用可选的原生 opaque ID，不把多选合并成字符串。
- 自由输入回传 `Other`，实际文本放在 `annotations[问题文本].notes`；选项的 preview 以普通文字展示，并按原生格式回传 `annotations[问题文本].preview`。多份 preview 用空行连接，不提供交互式预览 UI。
- 未回答的可选问题从 accepted 结果中省略；取消返回 `{ "outcome": "cancelled" }`，不得携带答案。校验失败不消耗待回答的问题。

例如选择 Alpha、Beta：

```json
{ "outcome": "accepted", "answers": { "Which letter?": ["Alpha", "Beta"] } }
```

## 生命周期与限制

只有匹配原生 Session 的活动 Prompt 才能创建问题；空闲、历史回放、手动压缩、关闭或跨 Session 请求取消，不弹卡片。同一 Turn 内重复的原生 tool-call ID 不会再次创建问题。旧 Turn 的回调、重复或迟到的答案不能回答新 Turn 的问题。

用户取消 Turn、Prompt 结束（包括失败）、Session fault 或 close 都会关闭问题并解除原生等待。原生 `interaction_resolved` 根据 tool-call ID 撤回对应卡片；此前工具审批的 resolution 不会屏蔽同一个工具随后发起的问题。

**超时仍由 Grok 决定。** Adapter 不设置 Host `expiresAt`、不自动选择推荐项，也不把原生超时结果冒充用户回答。原生撤回通知无法区分超时和其他撤回原因，因此公共关闭原因记录为 `cancelled`。

本实现不依赖 grokgod 的倒计时/活动续时补丁，不暴露其 timeout 元数据，也不发送活动续时请求。Grok 原生定时器仍可能结束提问；界面不显示倒计时。Plan 模式只提供普通回答/取消，不提供原生 TUI 的 Chat about this、Skip interview 等特殊动作。MCP `_x.ai/mcp/elicit` 不在此能力范围内。

Grok 插件需要升级；多选还要求 Host 与 Renderer 同时具备公共卡片支持，包括远程 Host。单独更新 Renderer 不能修复旧 Grok 插件的 Method not found。

## 来源与验证边界

问题转换与回传实现适配自 [karlorz/codex-host#12](https://github.com/karlorz/codex-host/pull/12)，固定版本 `07d8f010ae2e969007c611e035e49f3310b73a9d`，沿用 LGPL-3.0-only，并保留 karlorz 共同作者署名。Grok 协议细节仅在 Grok 插件内，没有 Grok 专用 Host / Renderer 分支。

自动化覆盖答案映射/非法输入、真实 ACP SDK 对接隔离子进程的反向请求与错误响应，以及 Session 的回答、撤回、取消、结束、fault、close 和跨 Turn 隔离。POSIX 子进程夹具在 Windows 跳过，纯映射和 Session 测试不受此限制。

这些测试不调用真实模型、不使用账号；不代表安装版 Grok CLI 或 Desktop 的人工验收已经通过。本次未修改原生配置，也未重启用户的 Desktop。
