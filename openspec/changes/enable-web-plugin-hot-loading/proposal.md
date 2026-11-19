# Proposal

## Why

Web 界面扩展目前需要重启 Web 才能启停，影响连接和终端。已有 DSH 底座支持插件生命周期和浏览器模块图同步，应复用这些能力实现热加载，而不是自建另一套机制。

## What Changes

- 普通运行时，启用、禁用、卸载已安装插件直接应用到服务端配套功能和已连接页面，无需重启 Web 或共享 Host。
- 安装仍默认禁用；启动恢复已保存选择的行为不变。
- 保留原包资源路由、依赖校验、管理认证、安全模式和恢复入口；仅支持首页初始化的贡献允许提示刷新页面。
- 官方热加载链路接通后，删除被其替代的自有通知和监听逻辑，保留开发模式外壳重建刷新。

## Decisions

- 复用 DSH Loader、ClientModules 和 client-hmr 前后端；自有代码只桥接安装选择、现有 HTTP 入口与运行结果。
- 保留界面插件的服务端配套入口，例如 Maid Atelier 的图片路由；不把“界面扩展”误当成“纯浏览器包”。
- 不引入完整 Node HMR、原生 DSH profile 或完整 Plugin Manager；不做插件原地升级、通用代码替换、配置编辑器或其他模块清理。
- 更新仅影响相关插件，不整体重装外置插件树或重启内置后端；不承诺撤销第三方代码任意副作用。

## Capabilities

### New Capabilities

- `web-plugin-runtime`: 增加运行中启停和页面同步要求。沿用前序变更的同名能力路径；该能力尚未同步到主规格，不另建近似能力。

### Modified Capabilities

- 无已归档主规格变更。合并规格时，本提案替代 `reuse-native-dsh-web-plugin-runtime` 中“保存启用选择不执行入口”和“重启生效与资源释放”的重启限制；纯安装仍不执行入口。其余原包兼容与恢复要求不变。

## Impact

涉及 `packages/web-server`、`apps/web-ui/packages/host/dsh-web-backend`、DSH 客户端 HMR、扩展设置文案与发行装配。沿用安装目录、持久化格式和管理权限；不改 Rust、Harness Adapter、Thread 执行或共享 Host。同步维护 `docs/product/web-ui-extensions.md` 与上游导入记录。
