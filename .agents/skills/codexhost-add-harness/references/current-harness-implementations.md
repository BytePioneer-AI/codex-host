# 实现导航：按职责选择参考

本页帮助定位代码，不维护完整能力矩阵。能力真相来自当前 inspect、Session capabilities、实际分支和测试；不要把历史说明或其他 Harness 的能力当作目标原生系统的保证。

所有路径以仓库根目录为基准。选一个最接近的原生传输作基础，再按需要读取专项模块和对应测试；不整包复制。

## 先看最小插件交付形态：Pi

```text
packages/adapters/pi/
├─ manifest.json             静态插件声明
├─ src/plugin.ts             createHarnessAdapter 工厂
├─ src/pi-adapter.ts          PiAdapter + PiHarnessSession
├─ src/pi-rpc-session.ts      原生进程与 RPC，不是公共 Session 类
├─ src/command.ts             Pi 的发现规则，调用公共 discovery
├─ src/pi-model-catalog.ts    原生模型/Thinking 转换
├─ src/pi-history.ts          原生历史与边界转换
├─ src/pi-last-turn-rollback.ts  回滚流程及结果验证
├─ src/pi-session-file.ts     原生 Session identity/cwd 校验
├─ src/pi-usage.ts            Usage 转换
└─ test/                     公共行为与原生边界测试
```

这不是新插件必须复制的文件列表。最小运行交付是 Manifest + 可执行工厂及其实现/依赖，图标等资源按需携带。`src/index.ts` 是包导出入口，不是 Loader 的工厂入口。

Pi 适合观察 CLI/RPC、延迟启动、history、模型/Thinking、Question、Usage 与关闭。Pi 不提供可选 Session Permission Mode；接受执行意图不等于需要新增权限参数。

## 七个 Harness 的传输参考

以下相对文件路径均位于对应的 `packages/adapters/<目录>/src/`。

| 目录 | 原生接入方式 | 优先读取 | 注意 |
|---|---|---|---|
| `pi` | CLI 原生 RPC | `plugin.ts`、`pi-adapter.ts`、`pi-rpc-session.ts` | 适合作为 RPC 基础；Entry/Session 文件格式仅属 Pi |
| `omp` | CLI 原生 RPC | `plugin.ts`、`omp-adapter.ts`、`omp-rpc-session.ts` | 适合权限重启、Approval/Question、Subagent、自主 Turn |
| `claude-code` | Claude Agent SDK；受管场景可经 Broker | `plugin.ts`、`claude-code-adapter.ts`、`sdk-transport.ts`、`transport.ts` | SDK、交互和生命周期参考；工厂中的直接/Broker 选择不代表所有插件都需要 Broker |
| `opencode` | SDK 客户端与原生服务/事件流 | `plugin.ts`、`opencode-adapter.ts`、`sdk-transport.ts`、`server-connection.ts`、`protocol.ts` | 适合共享服务与事件关联；权限写入有增量规则，不能假定配置可全量替换 |
| `grok` | ACP + 原生私有扩展 | `plugin.ts`、`grok-adapter.ts`、`acp-transport.ts` | 无可靠原生替代时才参考 ACP；权限创建期固定，私有历史扩展不能当标准 ACP |
| `deepseek-harness` | 按原生版本选择 Legacy/Modern 协议 | `plugin.ts`、`deepseek-harness-adapter.ts`、`generation-selector.ts`，然后进入 `legacy/` 或 `modern/` | 两代是不同基线；必须分别读所选实现与测试，不混用旧能力表 |
| `antigravity` | CLI stream-json | `plugin.ts`、`antigravity-adapter.ts`、`stream-events.ts`、`history.ts` | 适合流式 CLI 与插件持久化历史；当前明确不支持 Fork/Rollback |

原生 Codex 走官方 app-server，不实现外部 HarnessAdapter，不作为新外部插件的模板。

## 按目标能力继续读

| 目标 | 参考入口 |
|---|---|
| 公共错误、交互验证、Usage 解析、输出流 | `packages/harness-adapter/src/index.ts` 导出的工具及各自测试 |
| CLI 搜索与调用 | `packages/harness-discovery/src/index.ts`、Pi `command.ts`；公共机制与插件规则分别拥有 |
| 模型 opaque identity、Thinking 与历史 | Pi `pi-model-catalog.ts`、`pi-history.ts`、`pi-last-turn-rollback.ts` |
| SDK Approval/Question 与工具投影 | Claude `claude-code-adapter.ts`、`sdk-transport.ts` 及专项模块；按问题选择，不读完后整包复制 |
| 原生权限确认和重启恢复 | OMP `omp-adapter.ts`；OpenCode `permission-modes.ts` 和 `opencode-adapter.ts`；Grok 创建期作用域 |
| Subagent、自主 Turn、后台结果 | OMP/Claude Adapter 及生命周期模块；公共类型在 `text-session.ts` |
| 常驻 Host RPC/共享订阅 | DeepSeek `legacy/host-client.ts`；Modern 读 `modern/remote-connection.ts`、`event-gateway.ts` 和 `session.ts` |
| 原生协议代际选择 | DeepSeek `generation-selector.ts`、顶层 Adapter；原生版本策略不等于插件 API 版本 |
| 导入候选与本地 Web UI | DeepSeek 顶层 Adapter、`modern/session-list.ts`；Host 上层仍有专用边界 |
| 插件工厂和非阻塞预取 | 七个 `src/plugin.ts`；只有确有预取需求时参考 Claude/Antigravity 的 warmup |
| 公共行为测试模式 | `packages/harness-adapter/src/testing.ts`、`packages/harness-adapter/test/text-session.test.ts`；Fake 是参考，不是自动证明插件正确的 conformance runner |
| 插件加载/打包 | [加载与验证](registration-and-validation.md) |
| Desktop 或跨 Harness 协调 | [Renderer](renderer-product-integration.md)、[委派](cross-harness-delegation.md) |

读取参考源码时同时读取相应 test；尤其确认取消、部分启动失败、原生状态未知、资源关闭和版本差异，而不只模仿成功路径。

## 参考实现不应带入的新依赖

- Host 静态 Adapter 注册已删除；新插件只经 Manifest/工厂加载。
- 旧七种 transport codec 是历史兼容；新 ID 用共享路由。
- Host 恢复中的 Harness 名称判断、Credits 结构检查、DeepSeek 专用导入、Claude Broker 协议和 Renderer 静态映射仍存在；它们不是公共 Adapter 的新必需接口。
- 具体 SDK/RPC、原生权限恢复和历史版本逻辑属于插件；公共 Thread identity、映射事务、交互关联和委派业务仍属于 Host。

遇到与参考实现不同的原生语义时，先判断公共接口能否表达：能表达则在插件内转换；不能表达则记录公共缺口和产品限制，不凭相似名称套用原生操作。
