# Proposal

## Why

Web 用户需要像 Codex Desktop 一样，通过粘贴会话 ID／链接或拖入历史会话，让当前 Agent 准确定位要读取的 Thread，而不必复制历史正文。

## What Changes

- 支持将侧栏中的本地共享 CH 外部 Thread 拖入聊天主区域（含输入框）；悬停时整区浅蓝高亮，显示“松开以引用聊天”与会话图标、标题预览，松开后在当前 Composer 插入蓝色行内引用，底层保留真实 Thread ID 与来源。
- 在受支持会话的「···」菜单增加“复制会话链接”，复制成功或失败均明确提示。
- 保持粘贴裸 ID、`codex://threads/<id>` 和 `thread://<id>?hostId=...` 的普通文本语义，验证它们在发送与排队编辑后不丢失。
- 复用现有 Skill 与 `codexhost thread read`，验证本地共享外部会话的端到端读取，不增加自动历史读取。

## Decisions

- 复用编辑器现有引用机制展示蓝色行内引用，支持与正文混排、删除和撤销；拖入覆盖与标题预览仅在有效拖动期间出现，离开、取消、结束后清理，不新增历史预览面板、查询状态、选择器或持久化模型，手工粘贴不做自动转换。
- 行内引用发送时序列化为 `[@标题](thread://<id>?hostId=local)`；菜单复制 `thread://<id>?hostId=local`。两者使用同一目标地址，标题只供展示，定位使用 canonical Thread ID 与来源。
- 不注入 CLI 教程或要求调用不存在的 `read_thread` 工具；保持现有 Agent 能力发现机制。引用不保证 Agent 必然调用工具，验收须包含明确请求读取的真实交互。
- 首版仅为本地共享 CH 外部 Threads 提供拖入及菜单复制能力。其他来源的手工链接原样保留，不扩展隔离 Web Codex、官方 Codex 或远程路由，不冒充可读取。

## Capabilities

### New Capabilities

- `web-thread-references`: Web 会话引用输入、无副作用提交及既有读取链路复用。

### Modified Capabilities

无；现有 `cross-harness-delegation` 的读取与能力发现契约不变。

## Impact

- `apps/web-ui` 的侧栏菜单、拖动与 Composer 行内引用接入；复用现有编辑器引用契约、文本发送、草稿和队列。
- `packages/web-server` 既有提交链路仅需回归验证；Host、CLI、Adapter 的接口与权限不变。
- 更新 `docs/product/standalone-web.md` 的当前行为说明；不引入依赖、存储迁移或新的 RPC。
