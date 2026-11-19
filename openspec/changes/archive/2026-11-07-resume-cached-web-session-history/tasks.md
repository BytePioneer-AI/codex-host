# Tasks

## 2. 审查修正

- [x] 2.1 日志窗口改为内部可变追加/前插，仅在保存缓存时复制；避免 Session 的逐事件发布调用 capture，定向测试验证快照隔离与追加不复制。

## 1. 连续历史续传

- [x] 1.1 扩展 follow 契约与 SessionLog 的 epoch、统一续传谓词和原子打开基线；加入 Web 服务端定向单测，验证无变化零历史记录、只发新增、reset/重启/同长度改写/越界回退、prepend 不换代。
- [x] 1.2 为 Session Controller/Gateway 日志流接入缓存恢复位置、连续增量合并和 Assistant/投影重建；扩展 `tests/dsh/connection/session-cache.spec.ts` 等定向 Vitest，验证持久尾与 transient 分离、流式续接、尝试结算、分页保留、8 项淘汰及未确认状态门禁。
- [x] 1.3 扩展 `packages/web-server/test/browser/ch-session-cache.test.ts` 及必要流式浏览器用例，验证即时缓存、同步提示、阅读锚点、失败重试与活动工具恢复；同步修改 `docs/product/standalone-web.md` 的最近缓存和历史恢复描述，仅描述现行行为。
- [x] 1.4 在固定历史夹具上比较现有全量打开与续传打开的整个响应 UTF-8 字节数，覆盖无变化、新消息、只有流式变化三种情况，并记录同口径压缩后大小；测试断言记录范围正确且节省重复历史，交付汇报给出实际数值而非估算。
- [x] 1.5 按实际改动包执行定向单测与浏览器测试、`npx tsc -b` 覆盖相关包、`npx tsc -p tests/tsconfig.json` 和 `npm run lint`，执行 OpenSpec 校验；记录实际命令及阻塞原因，不运行全量测试或用户服务 start/stop，不提交。
