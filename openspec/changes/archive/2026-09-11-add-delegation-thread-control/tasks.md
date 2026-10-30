## 1. 控制契约

- [x] 1.1 扩展 Delegation 控制类型、错误码和 Registry，加入 thread send/cancel。

## 2. Runtime 实现

- [x] 2.1 为外部 Harness Thread 实现 send、忙碌检查和 cancel。
- [x] 2.2 为原生 Codex Thread 实现官方 send/cancel 路径及终态跟踪。
- [x] 2.3 将 send/cancel 接入 AppServerHost、Remote/多 Session 路由和生命周期。

## 3. CLI 与发布入口

- [x] 3.1 新增 loopback `/v1/thread/send` 与 `/v1/thread/cancel` 路由。
- [x] 3.2 新增 CLI 参数解析、帮助、深度链接和结构化错误。
- [x] 3.3 更新 Launcher/npm 帮助文本和内置 Skill 执行指引。

## 4. 验证

- [x] 4.1 添加 CLI、控制服务、Coordinator 与 AppServerHost 聚焦测试。
- [x] 4.2 运行 typecheck、lint、格式、边界、聚焦测试、Rust 检查和 OpenSpec strict validation。
