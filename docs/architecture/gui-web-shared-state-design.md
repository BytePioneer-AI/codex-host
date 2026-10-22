# GUI/Web 会话所有权架构概览

本文描述当前实现的所有权边界；协议和产品行为见[客户端通道](host-client-channel.md)与[独立 Web](../product/standalone-web.md)。

## 执行流程

GUI 和 Web 网关通过动态端口与认证描述文件发现已运行的共享 Host，有则连接，无则通过原生 Launcher 的 `host ensure` 启动。Web 可在没有 Desktop 的情况下使用 Host；关闭任一前端不停止后台或正在执行的任务。

同一 Host 数据目录中的 `host ensure`、`host stop`、`host restart` 通过 `shared-host-lifecycle.lock` 串行执行。`ensure` 在持锁后重新检查后台是否可用；正常并发启动时，后续调用等待并复用已就绪的后台。`restart` 持锁完成停止、子进程清理、启动和就绪确认。操作锁不覆盖绕过这些入口或不支持该锁的旧客户端。

Rust 负责后台进程监管与正常退出时的子进程清理。生命周期操作锁只在操作期间持有，不是后台整个存活期的所有权锁，也不锁原生 Harness home 或阻止其他进程写入同一原生会话。Mapping Store 保留自身的存储锁。启动就绪超时表示结果未知，不会因此终止可能已在执行任务的后台；不提供监管者被强杀后的安全交接保证。详细语义见[客户端通道的独立后台生命周期](host-client-channel.md#独立后台生命周期)。

## 模块和数据边界

- `@codexhost/session-runtime` 只提供共享的投影、会话日志、用量计量与展示类型；它不再拥有独立会话运行器或组织存储。
- Host 通过安装插件公共契约加载 Adapter，不导入 web-server 应用代码或具体 Adapter。Web RPC/stream、认证、Push 与 UI 投影留在网关。
- external AppServerHost/Mapping Store 是外部 Thread 的唯一所有者，包括 Codex CLI：Adapter、原生引用、元数据、交互、跟进队列与导入都走外部 Thread 运行时。原生历史仍在 Harness 自己的 home 中。
- Codex CLI 使用 `codex-cli` 身份，Manifest 只声明 Web 界面。`surfaces` 只影响 Desktop 呈现：Desktop 的插件列表、新建路由、Thread 列表和 Thread 事件排除仅 Web 的 Harness；执行、存储与 client channel 不受影响。代码中不按 `codex-cli` 字面量特判。
- 保留 `codex` 身份给 GUI 官方路径：外部 Harness 路由、插件目录与偏好拒绝这个身份。GUI 原生 Codex 保留官方执行与历史，不变成 external Thread。官方项目只读，external 官方 pin 仍走 Desktop。

## 使用边界

Codex CLI 的原生 home 取自 `CODEX_HOME`，未设置时为 `~/.codex`。认证完全由原生 CLI 负责，Host 不读取、复制或预检凭据。GUI 与 Web 可以共用 home，但同一原生会话不要在两侧同时打开：Host 不为跨进程写入提供互斥。

不提供旧 standalone 数据迁移、回滚或交接入口，不检查或清理旧锁及迁移标记，不自动移动用户数据。`<data>/web-codex/` 的旧隔离来源数据不读取、不删除、不迁移，也不出现在 Web 会话列表。未知提交不重发，不恢复不存在的内存队列；Host 失联时 Web 不回退到本地执行。Push 依赖 Web 网关存活。
