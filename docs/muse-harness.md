# Meta Muse Code

Muse 插件位于 `packages/adapters/muse`，ID 为 `muse`，通过原生 `muse serve` 的 MSP 接口运行。构建使用公共插件加载器，Desktop 使用共享插件路由；Host 不静态导入 Muse Adapter。

## 使用

安装并登录 Muse Code 后，在 Agent Picker 选择 **Meta Muse Code**。CLI 使用 `muse` 自动发现；需要固定安装时使用 `CODEXHOST_MUSE_COMMAND`。凭据由原生 Muse 读取，不复制到 Host 配置。

本次验证接口为 Muse Code **1.0.3（1.0.3-R2198.1）**。模型目录来自原生 `model/list`。Thinking 使用 MSP 导出的枚举；CLI 帮助中的选项不自动视为 MSP 支持。

默认权限为 `promptUnmatched`：原生规则已允许的操作直接执行，其余在 Desktop 请求批准。另提供 `denyUnmatched`。该版本的默认 `serve` 启动策略拒绝 `onRequest` 和 `allowAll`，故菜单不展示这两种不可用选项。旧引用仍可解码，原生拒绝会明确返回错误，不静默替换权限；不自动回答审批，不关闭 sandbox。

## 会话与故障

- 原生 Session 和 Turn ID 用于持久化、恢复和历史对齐。完整结束的会话可在 Host 重启后继续。
- `item/delta` 按原生增量追加，以事件 cursor 去重。输出事件持有独立快照，避免异步消费时把最终全文再次追加。
- 子会话、旧轮次和迟到事件不会完成当前轮次。原生 `turn/completed` 是父轮次终态依据，后台子任务可继续更新自己的状态。
- 原生取消失败返回错误，不能宣布已经取消。进程故障使活动轮次明确失败，并阻止后续提交到失效进程。RPC 应答默认等待最多 30 秒，超时关闭失联进程。
- 历史按原生分页顺序及 Turn ID 合并，保留失败、取消和未知终态；缺失结束记录不冒充成功。

当前限制：尚未实现跨 Host 的活动审批接管。恢复结果仍有活动 Turn 或待回答交互时，返回可重试的 `sessionBusy`，保留原始历史及映射。不能将这类恢复称为无缝接管。跨目录 Fork、末轮 Rollback 不支持；未验证的平台、远程 Host 和原生子任务行为不因本机测试通过而自动获得保证。

Host 的跨 Harness 委派目前要求 `unattended-full-access`，而该原生版本不接受相应 `allowAll`。因此 Muse 暂不能作为全自动委派目标：Adapter 在启动进程前返回明确 `unsupported`，不静默降权或伪造审批。普通交互式 Muse Thread 与观察 Muse 自身子任务是不同能力，不能据此前者可用就宣称完整委派对等。

## 验证与更新

在仓库支持的 Node 22 或 24 下执行：

```sh
npm run build:typescript
npm run build:renderer
npx vitest run --config tests/vitest.config.js packages/adapters/muse/test
```

默认单元测试不访问 Keychain、不发送真实模型请求。已登录本机的完整门禁需要显式启用：

```sh
CODEXHOST_MUSE_LIVE=1 npx vitest run --config tests/vitest.config.js packages/host-runtime/test/muse-live.test.ts
```

该门禁从临时插件根目录加载打包后的 Muse，使用真实 Host 路由和临时 Mapping Store，验证中文输出、持久化、Host 重启恢复、固定测试命令审批及取消续聊。官方 Codex 子进程使用测试替身；这不替代实际 Desktop 重启后的运行态核验。可设置 `CODEXHOST_MUSE_LIVE_ARTIFACT_DIR` 保存测试对话与验收记录。

macOS 沙箱可能阻止 Muse 读取它自己的 Keychain 项，报 `keychain item for meta is unreadable (os status -50)`。应区分执行环境限制与账号失效，不读取或导出凭据来规避。

插件和 Renderer 不支持热替换。构建通过后，在所有活动任务结束时运行 `npm start -- --no-build`，再检查新运行态。只覆盖磁盘文件或重载 Renderer 不会更新已加载的插件。单独终止 Controller 或 Host 也可能结束 Desktop 和其中的官方任务，不能当成无中断升级。
