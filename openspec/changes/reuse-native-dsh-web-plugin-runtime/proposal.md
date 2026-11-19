# Proposal

## Why

Web 只读取 DSH 插件的客户端产物，会跳过 Maid Atelier、Open Sea 等插件用于分发图片和渲染器的原生服务端入口。应复用 DSH 已有的 Web 插件运行机制，让原包完成自身功能，而不是继续增加插件专用资源映射。

## What Changes

- **BREAKING**：已启用且带服务端入口的 Web 扩展，在下一次普通 Web 启动时执行该入口；安装和保存启用选择仍不执行入口，纯客户端包继续可用。
- 接通原生 bundle 组合、插件加载、服务依赖、资源路由与客户端装配；保留原包代码及资源布局。
- 保留现有安装记录、本机管理、重启生效和恢复入口；补齐服务端启动失败、资源清理和卸载时文件存续行为。
- 以未修改的 Maid Atelier、Open Sea 验收源码与发行运行，并将 codexhost 核心功能回归纳入完成标准。

## Decisions

- 复用固定版本的 DSH/Cordis 加载、bundle、webServer 和 client-modules 代码，只适配现有 HTTP、认证、包解析和发行接缝，不维护第二套插件装配语义。
- 插件是同进程、同页面的可信代码；不新增沙箱、权限系统或运行审批。不承诺隔离任意插件副作用。
- 继续由 codexhost 持有 HTTP 监听、认证、核心路由、Harness 与 Thread 数据。用户扩展不能通过装配覆盖内置服务或模块，不启动另一套 DSH Agent Runtime，不为缺失服务伪造实现。
- 管理界面、安装来源和重启生效方式不重做；不新增通用配置编辑器、热启停或 Agent 能力兼容层。整服务安全模式不执行用户插件；页面级恢复不承诺停止已运行的服务端插件。

## Capabilities

### New Capabilities

- `web-plugin-runtime`：原生 Web 扩展的服务端与客户端协同运行、路由归属、依赖诊断及生命周期恢复。

### Modified Capabilities

无主规格路径需要修改。此变更承接尚未归档的 `add-web-dsh-client-extensions`，扩展其客户端阶段的运行范围；保留安装、管理访问与重启生效约束，替代其“不引入服务端插件运行时”的范围限制。

## Impact

影响 `apps/web-ui` 的 DSH 复用包与 `@codexhost/dsh-web-backend`、`packages/web-server` 的启动装配、资源与发行打包，以及相关测试和扩展文档。运行依赖须在源码与仓库外发行目录均可解析并共享宿主实例。继续使用 Web 数据目录，不迁移用户 DSH profile，不改 Harness 协议或 Thread 存储；验证使用隔离数据与端口，不操作正在使用的服务。
