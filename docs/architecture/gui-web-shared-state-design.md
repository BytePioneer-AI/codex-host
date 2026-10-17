# GUI/Web 会话所有权架构概览

本文记录当前实现的所有权边界，最终验证状态以OpenSpec任务记录为准。执行范围与验收以 [OpenSpec 提案](../../openspec/changes/unify-gui-web-session-ownership/proposal.md)、[设计](../../openspec/changes/unify-gui-web-session-ownership/design.md)、[规格](../../openspec/changes/unify-gui-web-session-ownership/specs/shared-web-codex-ownership/spec.md)与[任务](../../openspec/changes/unify-gui-web-session-ownership/tasks.md)为准；当前行为见[客户端通道](host-client-channel.md)与[独立 Web](../product/standalone-web.md)。

## 当前范围

默认 shared 的 external Harness 已由唯一 Host 拥有。本变更把显式启用的一个隔离 Web Codex 来源从 Web server 转交同一后台：既有 runtime、metadata、presentation journal 与 Web 自有 workspace/local pin/archive 一并由 Host 保存。Web 成为认证网关和协议投影客户端；停止 Web server 后后台执行继续，Push 仍依赖网关存活。

不重做 external AppServerHost/MappingStore、不搬已共享偏好或排序，不统一所有 schema/物理目录。GUI 原生 Codex 保留官方执行与历史，不变成 external 或隔离可执行地址。GUI 展示新来源、Host workspace 接入官方侧栏均不在本期。

## 模块和数据边界

- `@codexhost/session-runtime` 仅抽取现有隔离 Sessions 的运行/恢复与持久化；Host 与 explicit standalone 使用同一实现。沿用实际 Harness 类型与窄方法，不构造另一套通用 Harness Host。
- Host composition 通过安装插件公共契约注入固定单 home 配置；不导入 web-server 应用代码或具体 Adapter。Web RPC/stream、认证、Push 与 UI 投影留在网关。
- 保留独立 canonical home、插件 scope 与 nativeRef locator guard。跨进程地址由服务端给出并校验，客户端不能据 scope 自选 home/nativeRef；未知/跨来源请求明确拒绝。
- external 保留既有存储。隔离来源保留 index、events/projections 与完整 checkpoint/backfill/children 语义，不能只搬 index 或把 presentation journal 冒充 native事实。
- 只迁明确 Web 自建 workspace定义与隔离local会话归属/pin/archive，按来源投影；mixed文件中的external/自动reference数据排除并报告，不作该来源权威。官方项目继续只读；external 官方 pin 仍走 Desktop，不产生第二权威。官方 pin 离线不可写不阻止会话使用。

## 迁移与不变量

只迁一个显式源，在旧服务运行时确认无活动/队列/交互/未决操作，再正常停写并确认 native 退出。锁内 staging 验证完整集合，原子 commit 后目标才成为权威；未知格式、坏数据、ID/目标冲突阻止迁移并保留源，不自动改 ID 或 dedup。commit封存旧源以阻止新版writer重开；旧无锁二进制仍须停用。

原 canonical home 与历史附件路径原位保留，不迁凭据/附件字节、不做 GC。未知提交不重发，崩溃恢复不恢复不存在的内存队列。目标有新 mutation 后不得自动回滚旧副本；shared 失联不得 fallback 本地执行。standalone 只保留同实现的独立 composition，同 root/home 禁止并发，顺序交接须确认退出与转移锁。shared崩溃恢复验证Rust退出证明与旧锁的PID、generation、canonical root匹配；离线回滚入口先原生stop与锁确认，只在无新mutation时解封源并封存目标配置。

本期不增加多 home 产品注册、泛型命令总线、平行 event/revision 系统、alias 自动修复、草稿同步、队列持久化或 Codex 用量存储。

实现验证使用隔离owner/原生协议fixture与真实浏览器；另以全新临时HOME及Codex CLI 0.161.0完成只读initialize、model/list与关闭smoke。未进行真实模型请求或GUI原生会话写入，不将这些测试等同真实账号/所有平台验收。
