## 1. 协议与持久化基础

- [x] 1.1 根据当前 Desktop 内置 Codex CLI 生成并核对 `thread/list`、`thread/archive`、`thread/unarchive`、`thread/metadata/update` 及通知 Schema，记录本次实现实际支持的字段和协议差异
- [x] 1.2 在 Protocol Core 增加 Thread 列表与管理请求的有界解码、Host cursor 运行时校验和查询指纹，并覆盖无效参数、未知过滤字段和 cursor 错配测试
- [x] 1.3 在 Mapping Store 增加幂等 `setArchived()`，复用现有原子替换路径并保证 no-op 不增加 Revision
- [x] 1.4 扩展 Mapping Store 测试，覆盖 Archive/Unarchive 重启恢复、原子替换失败保持旧状态、防御性列表副本和禁止内容字段
- [x] 1.5 将 `listThreads()` 与 `setArchived()` 暴露到 `ExternalThreadStore` 和 `ExternalThreadRepository`，保持 Metadata-only 接口不依赖 Adapter

## 2. External Thread 元数据目录

- [x] 2.1 新增聚焦的 External Thread metadata catalog 模块，只选择 `ready` 且具有 Native 身份的记录，并用一次内存 Map 解析 Fork 树 `sessionId` 和循环错误
- [x] 2.2 实现 Metadata-only Codex Thread 投影：未加载状态为 `notLoaded`、已加载状态来自 Runtime、`turns=[]`、空 Preview、持久标题和 `isPinned=false`
- [x] 2.3 实现归档、cwd、Provider、来源、标题搜索、Pin、parent/ancestor 和 `useStateDbOnly` 对 External 候选的过滤语义
- [x] 2.4 实现 `created_at`、`updated_at`、`recency_at` 正反向排序和稳定 Host Thread ID tie-breaker
- [x] 2.5 实现 External 稳定锚点分页，并覆盖 ready/provisional、加载/未加载、Fork 树、筛选、同时间戳、一侧空结果和未知过滤字段测试

## 3. 官方列表关联与双来源聚合

- [x] 3.1 在 Host Runtime 增加隔离的官方内部请求 ID 和 pending response broker，使聚合请求可以等待官方列表响应而不影响普通响应、通知或 Host Question
- [x] 3.2 为 broker 增加官方错误、格式错误、进程退出、Host 关闭、重复 ID 和有界清理测试
- [x] 3.3 实现官方页与 External 页的两路有序归并，在官方批次只消费前缀时重新取得精确官方边界，不把未消费 Thread 行编码进 cursor
- [x] 3.4 实现组合 `nextCursor` 与 `backwardsCursor`，覆盖来源交错、一侧提前耗尽、limit、同时间戳、方向反转、查询变化和多页无重无漏
- [x] 3.5 在 `AppServerHost` 接管 `thread/list`，使用 Desktop 原请求 ID 返回唯一聚合响应，并在任一来源失败时拒绝部分成功
- [x] 3.6 增加 Host 集成测试，证明列表只读 Mapping Store、不打开 Pi/Claude Adapter、不读取 Snapshot，并保持未知官方 Thread 列表行为和通知透明

## 4. Archive、Unarchive 与管理兼容

- [x] 4.1 在 Host 按持久化归属接管 External `thread/archive`，先落盘再响应并发送 `thread/archived`，同步已加载 Runtime Record 但不关闭 Session
- [x] 4.2 接管 External `thread/unarchive`，返回 Metadata-only Thread 后发送 `thread/unarchived`，并验证重启后的普通列表重新出现该记录
- [x] 4.3 覆盖 Archive/Unarchive 幂等、写盘失败无通知、活动 Turn 不受影响、Native Session/Turn/Fork 映射保持和未注册 Harness 记录可管理
- [x] 4.4 接管引用 External Thread 的 `thread/metadata/update` 并对 Pin/Git 元数据明确返回 unsupported，确保 External ID 不进入官方 Codex
- [x] 4.5 增加官方 `thread/archive`、`thread/unarchive`、`thread/metadata/update` 原帧透传及官方响应/通知不变的回归测试

## 5. 验证与基线同步

- [x] 5.1 运行 Mapping Store、Protocol Core、Host Runtime 聚焦测试以及 TypeScript build、typecheck、lint 和 format 门禁
- [x] 5.2 增加 1000 个 External Thread 的启动枚举、筛选和首屏列表方向性测量，记录结果但不预设跨机器 SLA
- [x] 5.3 在受控当前 Desktop 中验证普通列表、归档列表、Archive、Unarchive、分页继续和 External Agent 图标归属，保存不含标题、cwd、Thread ID 或 Transcript 的最小证据
- [x] 5.4 回归官方 Codex 列表、归档、恢复归档和未知字段透明性，并记录未执行的跨平台 Gate
- [x] 5.5 更新数据持久化、技术架构、工程落地和开发步骤文档，使当前能力、Pin 降级、Detach 非目标和验证结果与生产代码一致
