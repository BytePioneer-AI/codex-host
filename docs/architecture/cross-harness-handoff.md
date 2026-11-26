# 跨 Harness 上下文交接（Cross-Harness Handoff）

跨 Harness 上下文交接允许用户从任意已有 Thread（官方 Codex 或外部 Harness）的已完成 Turn 出发，在相同工作目录（`cwd`）下派生一个目标 Harness 的独立新 Thread，并将按规则裁剪的上下文注入目标会话。每个 Thread 仍严格归属单一 Harness，源 Thread 保持只读不动。

## 契约与持久化

- **共享契约**（`packages/shared-contracts/src/thread-handoff.ts`）：
  - Host RPC：`codexhost/thread/handoff`（`THREAD_HANDOFF_METHOD`），参数为 `sourceThreadId`、可选 `lastTurnId`、`targetHarnessId`、可选 `targetModel`（原始模型 ID 或 `harnessModelRefKey`）与可选 `targetThinkingOptionId`。
  - 返回 `{ threadId, handoff }`，其中 `handoff`（`ThreadHandoffMetadata`）记录来源与目标 Harness/Model、总轮数、交接点轮次号、携带轮次列表、省略轮次数、`<handoff_context>` 预览文本与创建时间。
  - `codexhost/thread/inspect` 与 `ClientThreadSnapshot` 均携带可选 `handoff` 字段；Web 端投影键为 `codexhostHandoff`（`WEB_HANDOFF_PROJECTION`）。
- **元数据持久化**（`packages/mapping-store/src/thread-handoffs.ts`）：
  - 以目标 `targetThreadId` 为键写入 `<store>/handoffs/handoffs.json`，官方 Codex 与外部 Harness 目标统一保存。
  - 删除目标 Thread 时自动清理对应交接记录；读取该元数据不唤醒冷态会话。

## 上下文打包规则

由 `packages/host-runtime/src/thread-handoff.ts` 纯规则构建，不调用 LLM 总结，总大小硬上限为 `16,000` UTF-8 字节（`<handoff_context>...</handoff_context>`）：

1. **交接头与最新 Plan**：包含防注入说明（声明内容为历史记录而非新指令）、来源 `thread://`、来源与目标 Harness/Model、`cwd`、轮次边界、以及现有 CLI 原文回查命令：
   `"$CODEXHOST_CLI_PATH" thread read <sourceThreadId> --view messages --from <n> --to <m> --format text`
   若源会话存在 Plan，紧随其后附上（上限 2 KB）。
2. **初始需求锚点（Turn 1）**：仅保留第 1 轮用户输入，超长时按 UTF-8 字符边界截前段（`cutStartUtf8`）。
3. **尾部倒序完整轮次**：从交接边界 `K` 往前倒序装填，至少保底包含第 `K` 轮。单条消息上限 5 KB，采用非对称截断——用户输入留开头，助手回复留结尾以保留结论；最近 1–2 轮附简短 `[edited <path>]` 与 `[command: ... (ok|failed|cancelled)]` 摘要以补齐 `thread read --view messages` 不含工具记录的空白。
4. **中间省略轮次目录**：当存在被省略的中间轮次时，在剩余预算内附每轮 1 行索引（最多 25 行、上限 2 KB，取用户首句前 50 字符），超出上限仅标明省略区间供新 Agent 通过 CLI 按需分页读取。

## 双通道注入与边界

由 `packages/host-runtime/src/thread-handoff-executor.ts` 统一执行四向交接（`Codex ↔ 外部 Harness`、`外部 A ↔ 外部 B`、`Codex → Codex`），仅以 `status === "completed"` 的 Turn 作为有效交接边界，且仅当 `livePlan.turnId` 落在边界内才附带实时 Plan：

- **目标为官方 Codex**：通过官方 `thread/start` 创建新会话（如指定思考档位则写入 `config.model_reasoning_effort`），再调用原生 `thread/inject_items` 写入 `<handoff_context>`；注入失败时回滚清理新建 Thread 与交接记录。
- **目标为外部 Harness**：创建新外部 Thread 并将 `<handoff_context>` 写入 `pendingInjectedText`，首轮发送时由 `withInjectedText` 自动置前、回放时由 `withoutInjectedText` 按 SHA-256 剥离前缀以保持气泡干净。对于延迟生成 `nativeRef` 的外部 Harness（如 Claude Code、Antigravity、Pi），带有待注入上下文的 `creating` 记录会立即进入 `thread/list` 并在重启后保留，冷态打开或首轮发送时懒创建底层会话、注入上下文并绑定 `nativeRef`。已注册的原生 Harness 斜杠命令在 `#beginExternalInputTurn` 中走 `#beginExternalCommand` 而不经过普通 Turn 注入路径，因此自然延后至下一条普通用户消息再注入，而 `/tmp ...` 等普通路径文本则正常注入上下文。

## Web 与 Desktop 入口

- **Web 网关与前端**（`packages/web-server/src/ch-thread-handoff.ts`、`apps/web-ui`）：
  - `session/handoff` 解析消息边界 `atSeq`（缺省时取最新已完成轮次）并调用 `codexhost/thread/handoff`，刷新会话后通过 `codexhostHandoff` 投影持续展示。
  - 已绑定本地会话的 Composer Harness 选择器（`HarnessSelect`）在当前 Harness 下方列出可交接的目标 Harness，点击后打开目标选择弹窗（`HandoffModal`）并自动预选该 Harness 与其默认模型；消息尾操作栏（`TurnTailNodeView`）保留任意历史轮次切点的「上下文交接」入口。新会话顶部在首轮已加载时渲染居中可折叠的 `HandoffDivider`（显示来源 → 目标图标与名称、轮次摘要、跳回源会话按钮及只读预览）。
- **Codex Desktop 扩展**（`packages/renderer-extension/src/renderer-handoff-control.ts`、`renderer-handoff-view.ts`）：
  - 在已绑定会话的 Composer 尾部工具栏挂载触发按钮与目标选择弹窗（按当前 Host 路由 `clientForHost`，模型选项保留 `harnessModelRefKey`），确认后通过 `openRendererThread` 切入新会话。
  - 打开带 `handoff` 元数据的会话时，在首轮消息前（空会话回退至 Composer 上方）渲染居中可折叠的交接分割条，支持跳回源会话与只读预览，切换会话或卸载时完整清理。
