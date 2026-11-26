# Design

## Context

动机与实测背景见 [proposal.md](./proposal.md)。本变更横跨桌面壳（Rust/Tauri）、Web UI 客户端多个包与 Node Web Server，并已在本集成分支先行合入 3 项零副作用基础修复（2× Retina 边线层轻量化、Remote Peer 10 分钟空闲退役、Desktop MCP Bridge 关闭超时与 SSE 存活清理）。剩余 6 个子模块职责边界清晰、文件无重叠，适合在独立 worktree 并行开发后统一集成，并由独立审查与隔离实测验收整体前后降幅。

## Decisions

### 1. 隐藏窗口动画冻结（Track A）
- **方案**：在 `apps/desktop-shell/src-tauri/src/lib.rs` 的 `set_visible` 与窗口可见性变更路径向 WebView 同步根属性 `data-codexhost-window-hidden`；在 `apps/web-ui/packages/client/web/` 同时监听 `document.visibilitychange` 维护同一根属性（覆盖独立 Web 标签页与 macOS 遮挡）；在 `apps/web-ui/packages/client/web/src/base.css` 通过 `html[data-codexhost-window-hidden]` 对无限循环装饰动画应用 `animation-play-state: paused !important`。仅在真正隐藏、最小化或 `document.hidden` 时生效，普通失焦窗口不暂停。
- **放弃的方案**：隐藏窗口时销毁或重建 WKWebView（恢复白屏与状态重建代价过高）。

### 2. PDF 离屏画布回收（Track B）
- **方案**：在 `apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx` 复用既有 `IntersectionObserver`（`rootMargin: "100% 0px"`），当页面 `visible` 变为 `false` 时中止在途渲染、将主画布重置为 `width = height = 0` 并清除 `renderedZoom`，同时在外层容器保留 `--pdf-page-width` / `--pdf-page-height` 并在 `.surface` 保持固定 `aspect-ratio`（就绪后观测带固定尺寸的 `.surface`，既不随清画布塌缩，又保留横向溢出可见性）。在 `document.ts` 将单页光栅像素上限由 `16_777_216`（~64 MiB）收紧至 `8_388_608`（~32 MiB，2× DPR 标准文档清晰度无损）。
- **放弃的方案**：卸载整个 PDF 页组件（会丢弃外层页码定位和文本选择容器稳定性）。

### 3. 历史长代码块折叠与超大块免高亮（Track C）
- **方案**：
  - 在 `ui-primitives/src/markdown/highlight.ts` 增加安全上限（`MAX_HIGHLIGHT_CHARS = 60_000`、`MAX_HIGHLIGHT_LINES = 1_500`）与有界 HTML LRU 缓存（240 条 / 24 MiB 估算上限），超限直接返回 `undefined` 走等宽纯文本 `<pre>`。
  - 在 `CodeBlock.tsx` 增加可选 `collapsible?: boolean` 与行壳作用域折叠记忆（`CodeBlockFoldMemoryProvider`）：当 `collapsible === true && streaming !== true` 且行数 `> 20` 时默认折叠为前 `8` 行预览（仅对可见预览片段高亮，不生成隐藏行 token span），底部提供展开/收起按钮显示总行数；用户手动展开或流式结算展开的状态随外层常驻行壳保留，避免虚拟化重挂载高度跳动；`onCopy` 始终复制完整 `trimmed` 源码。由 `ui-chat/src/client/chat/ChatMarkdown.tsx` 对会话流中的代码块启用 `collapsible`（不影响独立文件预览）。
- **放弃的方案**：更换语法高亮引擎（迁移与样式主题回归成本高，且折叠+降级+虚拟化已是控制 DOM 与分词开销的主杠杆）。

### 4. 工具输出预览全连接启用与历史页内存瘦身（Track D1）
- **方案**：
  - 放开 `packages/web-server/src/tool-output.ts` 中 `toolOutputSink` 对 `sink.relay` 的限制（含 `session/page` 与 `session/follow` 快照），让所有浏览器连接对已结束回合超预算工具输出统一走预览 + `session/toolOutput` 按需读取，前端原地展开与复制取全文路径零改动即可生效。
  - 在 `ChThreadHistory` / `ChThreadView` / `SessionLog` 中对已完成的历史回合记录工具输出预览与 SHA-256 指纹，允许历史翻页丢弃常驻内存中的超大原始输出正文；当 `session/toolOutput` 命中已释放正文的合法引用时，按 `hostThreadId` 向 Host 单次读取对应回合、经统一 100,000 字符投影规则校验 SHA-256 指纹后返回（不改变认证、授权与版本校验契约）。
- **放弃的方案**：永久截断丢弃历史工具原文（会伤害本机排障能力）。

### 5. 前端会话内存字节预算（Track D2）
- **方案**：
  - 在 `apps/web-ui/packages/api/session-controller/src/client/sessions/recent-views.ts` 为 `RecentSessionViews` 增加估算字节数统计与总字节上限（例如 `MAX_RECENT_VIEW_BYTES = 24 * 1024 * 1024`，同时保留最多 8 条上限）及 `ToolOutputCache` 字节封顶（如单会话 8 MiB LRU），超出时按最旧优先淘汰；
  - 在 `apps/web-ui/packages/client/ui-workspace/src/client/session-keepalive.ts` 将非运行态暖会话槽位从 8 收紧至 4，并结合会话已加载估算体积（或提供字节统计接口）在超过总暖会话预算（例如 `32 * 1024 * 1024`）时优先释放最旧的已停止暖会话，绝不释放正在运行或主视图正在引用的会话。
- **放弃的方案**：彻底取消暖会话缓存（会降低高频在 2–3 个常用会话间切换的瞬时响应）。

### 6. 长对话行壳内容虚拟化与搜索租约（Track E）
- **方案**：
  - 在 `apps/web-ui/packages/client/ui-chat/src/client/chat/` 新增聚焦模块（如 `use-transcript-virtualization.ts`），对 `ChatView` 的顶级 `entries` 在超过阈值（`VIRTUALIZE_THRESHOLD = 48`）时启用行壳内容虚拟化：
    - `ChatNodeSeat` / `ChatGroupSeat` 保留顶级外层 `div` 行壳、稳定 `data-chat-flow-key` / `data-chat-anchor-key` 与按行缓存的实测高度（切会话清理）；
    - 仅挂载视口上下各 ~1.5–2 屏 overscan 内的行正文，以及永久钉住集合：**尾部 `PIN_TAIL = 10` 条**、**当前选区覆盖的起止与中间全部行**（监听 `selectionchange`）、**正在编辑的消息行**、**`viewRequest` / Turn 导航跳转目标行**、**聚焦元素所在行**；
    - 监听全局 `Cmd+F` / `Ctrl+F` 快捷键（不阻止浏览器原生查找弹窗），激活临时查找租约（全量挂载已加载行，仅在查找快捷键与 `beforematch` 时续期，在 `Escape`、聚焦编辑控件、切会话或 30s 空闲后释放回虚拟化）。
- **放弃的方案**：整表替换为第三方虚拟滚动库（容易破坏既有 Turn 导航、选区批注、分组披露与滚动锚点协议）；强制劫持 `Cmd+F`（会改变原生习惯）。

### 7. 并行开发文件所有权隔离

| 轨道 | 独占改动目录 |
|---|---|
| Track A | `apps/desktop-shell/src-tauri/`、`apps/web-ui/packages/client/web/src/` |
| Track B | `apps/web-ui/packages/client/ui-sidebar-documentpreview/src/client/pdf/` |
| Track C | `apps/web-ui/packages/client/ui-primitives/src/markdown/`、`apps/web-ui/packages/client/ui-chat/src/client/chat/ChatMarkdown.tsx` |
| Track D1 | `packages/web-server/src/`、`packages/session-runtime/src/`、`packages/web-server/test/` |
| Track D2 | `apps/web-ui/packages/client/ui-workspace/src/client/session-keepalive.ts`、`apps/web-ui/packages/api/session-controller/src/client/` |
| Track E | `apps/web-ui/packages/client/ui-chat/src/client/chat/`（不改 `ChatMarkdown.tsx`） |

## Risks / Trade-offs

- [虚拟化高度估算偏差导致快速回滚微跳] → 行卸载前用 `ResizeObserver`/实测高度入表，仅对从未渲染过的行使用保守默认高度，并钉住尾部 10 行保证流式吸底稳定。
- [`Cmd+F` 租约期间大长会话瞬间挂载造成短暂停顿] → 仅在用户明确按下查找时按需触发，且折叠后的历史长代码块大幅降低了全量挂载时的 DOM 规模；查找结束后自动释放。
- [工具输出从 Host 回读在 Host 离线或历史改写时失败] → 严格沿用既有 `session/tool-output-stale` 与错误重试交互，复制失败绝不把预览写入剪贴板。
- [PDF 快速回滚出现短暂白底重绘] → 保持 `100% 0px` 预取缓冲，外层保留精确 CSS 宽高不跳动，滚入预取区即刻重绘。

## Migration

- 全部改动向前兼容现有持久化格式与 Web/Host 协议，无需数据迁移；可按轨道独立回退或分批合并。
