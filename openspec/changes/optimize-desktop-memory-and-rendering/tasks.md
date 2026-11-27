# Tasks

## 1. 基础零副作用修复（已合入集成分支）

- [x] 1.1 替换 2× 屏 `AppFrame` 超大边线伪元素为 1× `0.5px` `inset box-shadow`（验证：WKWebView / Chromium 2× 像素对比 0 px 差异，Prettier 通过）
- [x] 1.2 为 Remote Peer 补齐 10 分钟空闲双引用同步退役（验证：`npx tsc -b packages/web-server` 与 `remote-sessions.test.ts` 等 4 组测试全过）
- [x] 1.3 修复 Desktop MCP Bridge 客户端关闭挂起与独立 GET SSE 存活回收（验证：`desktop-mcp-bridge.test.ts` 20/20 通过）

## 2. 隐藏窗口动画暂停与 PDF 离屏释放

- [x] 2.1 Track A：实现桌面壳隐藏态与浏览器 `visibilitychange` 联动的无限动画暂停门控（验证：`cargo test --package codexhost-desktop-shell` 及 `web` 包相关单测/构建通过）
- [x] 2.2 Track B：实现 PDF 离屏页面取消渲染与 `<canvas>` 缓冲清空（保留占位几何）并收紧单页光栅上限至 8,388,608 像素（验证：运行 `ui-sidebar-documentpreview` 聚焦单测确认离屏释放与回滚重绘）

## 3. 代码块折叠降级与会话/工具输出内存预算

- [x] 3.1 Track C：实现 `highlight.ts` 超大块（>60k 字符 / >1500 行）纯文本降级与有界 HTML LRU，以及会话流已结算长代码块（>20 行）默认折叠为预览行且复制取完整原文（验证：运行 `ui-primitives` 代码块与高亮聚焦单测）
- [x] 3.2 Track D1：将 `web-tool-output-loading` 工具输出预览扩展至全部浏览器连接，支持历史页释放超大已完成工具输出并在 `session/toolOutput` 时按版本指纹向 Host 回读（验证：`npx tsc -b packages/web-server` 及 `packages/web-server/test/` 工具输出与分页相关单测全过）
- [x] 3.3 Track D2：为前端 `RecentSessionViews`、`ToolOutputCache` 与 `SessionKeepalive` 引入有界字节预算并收紧非运行态暖会话槽位（验证：运行 `session-controller` 与 `ui-workspace` 聚焦单测）

## 4. 长对话行壳内容虚拟化

- [x] 4.1 Track E：实现长对话顶级行壳内容虚拟化（阈值 48 行、实测高度占位、视口+缓冲区挂载、尾部 10 行与选区/聚焦/跳转目标钉住，以及 `Cmd+F`/`Ctrl+F` 临时全量挂载租约）（验证：运行 `ui-chat` 聚焦单测覆盖窗口化、选区保护、尾部保护与查找租约）

## 5. 集成审查与真实效果实测

- [x] 5.1 合并各轨道后派独立子会话执行全量代码审查（边界、安全、回归、测试强度）与隔离实测对比（`origin/main` vs 优化集成分支，在真实 macOS WKWebView 与隔离 Node 后端上复测 3,120 行长会话、16 会话切换、65 页 PDF、Web Server 16 线程与隐藏窗口 CPU，输出前后量化对比报告）
