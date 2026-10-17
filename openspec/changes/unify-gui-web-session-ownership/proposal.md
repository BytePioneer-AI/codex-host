## Why

默认 shared 模式的外部 Harness 已由独立 Host 后台拥有，但显式启用的 Web Codex 仍由 Web server 的 `Sessions` 拥有执行、原生引用和展示日志，Web 自建 workspace/local pin/archive 也存在本地文件。关闭 Web server 会关闭该执行来源；仅让两端读取相同文件无法保证唯一执行者。需要把这一现有来源的所有权转交后台，同时保留官方 GUI Codex 的原生路径。

## What Changes

- 共享 Host 托管一个显式配置的隔离 Web Codex 来源，包括既有 runtime、index、events/projections 与恢复行为；Web 成为认证网关和协议投影客户端。
- 从现有 Sessions 抽取实际需要的 owner 代码，shared Host 与 explicit standalone 使用同一实现；不重做 external AppServerHost、MappingStore 或通用 Harness Host。
- Web 自建 workspace 与 local pin/archive 随来源迁移，由 Host 保存，继续按来源投影；不复制 external 官方项目/收藏为第二权威。
- 为一个显式源提供停写后的完整迁移，保留 canonical home 和历史附件原路径；未知格式、活跃源或身份冲突阻止迁移并保留源，不自动改 ID。
- 复用现有客户端通道的失效通知、snapshot 和恢复方式，增加隔离来源的服务端地址校验及兼容能力门槛。

## Non-goals

不接管、导入或自动展示 GUI 原生 Codex Threads；不改写官方项目原文件或承诺 headless 官方 pin 写入。不新增多 home 产品功能、通用 owner registry、泛型命令总线、全局 revision/event 系统、自动 native 去重/alias、附件搬迁或 GC。已共享的偏好、排序、external 链路不重做。Codex 用量存储、草稿同步及队列持久化不在范围；保留当前队列行为。

## Capabilities

### New Capabilities

- `shared-web-codex-ownership`：规定隔离 Web Codex 的唯一 owner、原生边界、组织数据归属、单源迁移与恢复验收。

### Modified Capabilities

无。现有 external 与官方路由契约保持，本变更添加其旁边的隔离来源，不改变其语义。

## Impact

- `packages/host-runtime`：隔离来源 composition、生命周期及受限 client channel 接入。
- 拟议 `packages/session-runtime`：从 Web 抽取的现有隔离会话运行/恢复与持久化实现；仅通过公共 Harness 契约加载能力。
- `packages/web-server`：shared 模式改为后台客户端，standalone 复用相同实现；Web 自有组织数据迁移。
- `packages/shared-contracts`、`packages/desktop-control`：最小来源地址、能力门槛与现有通道调用，不引入另一套同步协议。
- Launcher 接入及发行配置：单来源参数、执行准入与旧 writer 停写/版本检查；Rust 仍负责原生进程树。
- 定向测试及现有功能文档；本提案全部尚未实现。
