## Context

基线为 upstream `9d36363f`。DSH 参考仓库版本为 `0.1.5-rc.1`，可通过 `dsh-v0.1.2-rc.1` 与 `dsh-v0.1.5-rc.1` 标签精确比较。当前 Facade 会先尝试 Legacy attach；Modern 读取 V0 日志，无法读取 015 的 V3 日志。已有未合入实验分支的双版本实现可作为代码参考，必须以本次真实 RC 源码复核，不引入其 013 支持。

## Goals / Non-Goals

**Goals:** 精确支持 012rc1/015rc1，删除 Legacy，保留两版完整现有功能，使用可执行测试证明边界和覆盖率，同步当前文档。

**Non-Goals:** 新增 DSH 版本、ACP/Python 接口、附件输入 UI、原生会话格式迁移器、用户数据改写、其他 Harness 或 Rust 改动、浏览器/computer use 测试。

## Decisions

1. `--version` 精确白名单选定一次版本；Facade 只创建 Modern Adapter。保留 loopback 端点校验与无凭据 401 指纹诊断，删除 Legacy 探测/attach/fallback。未知版本在启动 Web 前失败。
2. 复用现有 HTTP RPC、WebSocket mux、bootstrap cookie、control/event gateway；两标签的认证和控制基本契约不变。版本差异集中在 Adapter 内部的 012/015 profile，避免到 Host/Renderer 传播 DSH wire 细节。
3. 012 保持 V0、持久化 chunk 和 `turn-end:` checkpoint。015 要求 V3、`isSeeded`、`system/message`、`startSeq/endSeq`、独立 Assistant baseline/live stream 与 durable message/attempt；使用 `v3-turn-end:` 和版本 locator 防止旧 seq 被迁移后误用。未知 required 事件拒绝，未知 ignorable 事件仅保持原生允许的不透明数据。
4. 系统消息参与 surface 引用/替换但不投影为用户回合；结算/重连避免重复输出。015 新事件（PTC、deliverables、feedback、subagent catalog、team v2）按真实 payload 校验，不能整体关闭严格解析。Assistant 文本在持久化消息到达前实时投影；原生重试或放弃的部分输出以独立 Item 标记取消，成功尝试另行完成，重新读取持久化历史时只显示原生保留的消息。复用现有 Host Item 追加/完成契约，不篡改已发文本。
5. slash 命令按版本使用 `images: []` 或 `submittedAttachments: []`，沿用当前静态文本命令清单，不新增 native descriptor 探测或附件输入。创建、恢复、导入、Fork、回滚统一传递 profile；Fork 以原生 seed marker 和已验证前缀确认继承关系。
6. 删除仅 Legacy 使用的 apiproxy/session 依赖与打包项；保留 Modern 仍使用的 schemastery。Host 旧导入 RPC alias 并不是 DSH Legacy wire，保持其行为。
7. 使用现有 Vitest，补 V8 coverage provider 和独立 DSH 覆盖率入口，统计整个 Adapter 源目录及四项指标，门槛 80%。测试高于 90% 不删除有效测试。
8. 文档改写是交付项：更新专项支持说明、连接排障、导入、消息修订及打包说明；项目及多语言 README 保持原样。主规范同步本 delta，归档历史不追溯改写。plan/todo 仅本地保存，不纳入 PR；OpenSpec tasks 随步骤勾选。

## Risks / Trade-offs

- 日志迁移会重编号 seq → 格式限定 checkpoint；原生迁移由 DSH 自身处理，CH 不迁移或伪造旧 checkpoint。
- live 与 durable 事件到达顺序差异 → 测试 Assistant baseline、revision/index、重连和结算去重，并保留现有关闭/故障停止保证。
- 严格解析可能遗漏新合法事件 → 对照固定 RC 源码和脱敏 fixture，分别测试合法与错误输入。
- 真进程验证依赖本机 DSH 构建 → 优先源码 fixture 与协议服务测试；若可用再做隔离进程检查，最终明确证据类型，不冒称模型或桌面测试。
- 015 原生 Fork 扩展至下个 turn/start 前，继承队列在新 inbox projection 冷恢复时重放；012 只重放 ownEvents 不受此影响 → 用新子会话的权威 inbox 与 inherited prefix 证明来源，仅通过原生 `session/updateQueue` remove 清除继承待办，再重新读取并验证空队列与原始前缀。无法确认则不接纳，源会话不变。
- 015 原生写入存在 200ms 批量缓冲，Windows 强制结束进程可能丢失已收到回执的最后操作 → Fork 清理后和 Session 正常关闭时使用现有认证 `HEAD /api/session.export`；该原生路由先等待 `sessions.flush`、读取持久层，再返回 ZIP 响应头。仅确认状态和类型，不下载内容，不加私有 flush RPC 或延时猜测。

## Migration Plan

本次代码在指定 worktree 分支提交，每五个提交推送。发布后仅接受两版；旧 Legacy 用户按原诊断入口收到明确版本提示。原生数据和 Mapping Store 格式不变；回退 CH 不保证较新 DSH 日志可由旧 DSH 打开，因此不得自动降级会话数据。

## Open Questions

无须用户补充的规格问题。实现阶段以 RC 源码及测试证据持续核对具体事件字段，并在本设计和验证记录中同步实际结论。
