# 实现导航：按传输方式和能力选参考

本页只帮助定位代码，不是能力真相。能力以各插件当前的 inspect、Session capabilities、实际分支和测试为准；不要把其他 Harness 的能力当作目标原生系统的保证。

先选一个原生传输方式最接近的插件作为基础，再按需读专项模块**和对应的测试**，不整包复制。下文的相对路径都位于 `packages/adapters/<目录>/src/`。

## 最小交付形态：Pi

```text
packages/adapters/pi/
├─ manifest.json             静态声明（含 iconStyle、installation）
├─ src/plugin.ts             工厂：构造 Adapter，挂上 installation / install
├─ src/pi-adapter.ts          PiAdapter + PiHarnessSession（同一个文件）
├─ src/pi-rpc-session.ts      原生进程与 RPC（不是公共 Session 类）
├─ src/command.ts             原生 CLI 的发现规则（调用 harness-discovery）
├─ src/installation.ts        版本检查与更新
├─ src/pi-model-catalog.ts    模型与 Thinking 转换
├─ src/pi-history.ts          原生历史与边界转换
├─ src/pi-last-turn-rollback.ts  回滚
├─ src/pi-session-import.ts   导入
├─ src/pi-usage*.ts           会话用量与全局统计
└─ test/
```

这不是必须照搬的文件列表。`src/index.ts` 是包的导出入口，不是 Loader 使用的工厂入口。

## 16 个会话插件，按传输方式分组

| 传输方式 | 目录 | 先读 | 适合参考 | 注意 |
|---|---|---|---|---|
| CLI 原生 RPC | `pi` | `pi-adapter.ts`、`pi-rpc-session.ts` | RPC 基础、历史、Rollback、Question、Usage、Subagent 插件 | Entry/Session 文件格式只属于 Pi；没有权限模式 |
| CLI 原生 RPC | `omp` | `omp-adapter.ts`、`omp-rpc-session.ts` | 重启后恢复权限、Approval/Question、Subagent 订阅、自主 Turn、轻量的 `availability` inspect | |
| 官方 SDK | `claude-code` | `claude-code-adapter.ts`、`sdk-transport.ts`、`transport.ts` | SDK 交互、额度和 Credits、Plan 模式 | 工厂中的直接连接与 Broker 二选一，不代表其他插件需要 Broker |
| 官方 SDK | `qoder`（`qoder-cn` 复用） | `qoder-adapter.ts`、`qoder-sdk-transport.ts`、`qoder-runtime.ts` | **一份实现、多个变体**（`createHarnessAdapter(context, "cn")`）、按 cwd 缓存 Catalog、无人值守时用 bypass | 各变体的 SDK、命令和凭据目录相互独立 |
| SDK + 原生服务 | `opencode` | `versioned-adapter.ts`、`v2/`、`server-connection.ts` | 共享服务与事件关联、**原生版本代际选择** | 权限写入有增量规则 |
| ACP | `kiro-cli` | `kiro-adapter.ts`、`acp-transport.ts`、`turn-output.ts` | 标准 ACP、跨 cwd Fork | |
| ACP | `kimi-code` | `kimi-adapter.ts`、`kimi-session.ts`、`acp-transport.ts` | ACP `configOptions` 动态 Thinking、原生 Rollback、账号身份 | |
| ACP stdio | `codebuddy` | `codebuddy-adapter.ts`、`acp-client.ts`、`session.ts`、`derivation.ts` | 组合方式的 Fork/修订（复制 + `/fork` + rollback）、原生压缩确认、附加系统提示的委派 | 中间副本的回收见专属文档 |
| ACP（复用） | `workbuddy` | `plugin.ts`、`workbuddy-adapter.ts`、`credential-bootstrap.ts`、`delegation.ts` | **复用另一个 Adapter 包**、桌面应用内置 CLI、`launchCommand`、`versionKind:"application"` 与手动更新 | 不连接 WorkBuddy Desktop 的私有 runtime |
| ACP | `cursor-cli` | `adapter.ts`、`transport.ts`、`fork.ts` | 平台受限的 Fork、参数化 Thinking、无人值守时明确返回 unsupported | Windows 不支持 Fork |
| ACP + 私有扩展 | `grok` | `grok-adapter.ts`、`acp-transport.ts` | 创建时固定权限（`atCreate`）、Credits | 私有历史扩展不是标准 ACP |
| 官方 Gateway | `hermes` | `hermes-adapter.ts`、`gateway-transport.ts`、`gateway-open.ts` | 常驻 Gateway、按原生 Git 渠道更新、进程内临时 Skill 的委派、SessionDB 只读导入 | |
| 托管 Web Remote | `deepseek-harness` | `deepseek-harness-adapter.ts`、`generation-selector.ts`、`modern/`、`profiles/v4.ts` | 常驻 Host RPC 与共享订阅、最低版本门槛、请求级计量 | 线格式集中在 `profiles/v4.ts` |
| CLI stream-json | `antigravity` | `antigravity-adapter.ts`、`stream-events.ts`、`history.ts` | 流式 CLI、通过 Hook 桥接提问、额度 | |
| 桌面应用私有 app-server | `zcode` | `adapter.ts`、`session.ts`、`transport.ts`、`protocol.ts` | 直连已安装应用的 Agent CLI、`launchCommand`、自主 Turn | 不支持 Fork 和 Rollback |

原生 Codex 走官方 app-server，不实现外部 HarnessAdapter，不能作为新外部插件的模板。

## 按目标能力查参考

| 目标 | 参考入口 |
|---|---|
| 输出流、交互校验、Usage 解析、诊断脱敏 | `packages/harness-adapter/src/index.ts` 导出的工具及其测试 |
| CLI 发现、安装器、版本管理 | `packages/harness-discovery/src/index.ts`；Pi 的 `command.ts`、`installation.ts`、`plugin.ts` |
| npm 安装渠道的更新 | CodeBuddy、OpenCode、Grok 的 `installation.ts` |
| 模型身份、Thinking、历史 | Pi 的 `pi-model-catalog.ts`、`pi-history.ts`；Kimi 的 `models.ts` |
| Last-Turn Rollback | Pi 的 `pi-last-turn-rollback.ts`、OMP 的 `omp-last-turn-rollback.ts`、Kimi 的 `native-rollback.ts` |
| Fork（原生 / 组合实现） | Claude 的 `claude-fork.ts`；CodeBuddy 的 `derivation.ts`；Cursor 的 `fork.ts` |
| 审批、提问与工具投影 | Claude 的 `claude-code-adapter.ts`；OMP；Antigravity 的 `question-bridge.ts` |
| 权限的确认与恢复 | OMP 的 `omp-permission-modes.ts`；OpenCode 的 `permission-modes.ts`；Grok（`atCreate`） |
| Subagent、自主 Turn、后台结果 | OMP、Claude 的生命周期模块；Pi 的 `pi-subagents.ts` |
| 请求级计量 | Pi 的 `pi-usage.ts`；DSH 的 `modern/usage-metering.ts` |
| 全局统计 | Hermes、Grok 的 `usage-statistics.ts`；Qoder 的 `qoder-usage-statistics.ts`；Pi 的 `pi-usage-statistics.ts` |
| 账号额度 / Credits | Claude 的 `account-usage.ts`；Grok 的 `grok-credits.ts`；Antigravity 的 `quota.ts` |
| 会话导入 | 各插件的 `*session-import.ts`（如 Pi 的 `pi-session-import.ts`、Kiro 的 `session-import.ts`）；公共工具 `@codexhost/harness-adapter/session-import` |
| 常驻服务与共享订阅 | DSH 的 `modern/remote-connection.ts`、`event-gateway.ts`；Hermes 的 Gateway |
| 原生协议版本选择 | DSH 的 `generation-selector.ts`；OpenCode 的 `versioned-adapter.ts` |
| 公共行为测试模式 | `packages/harness-adapter/src/testing.ts`（`FakeHarnessAdapter` / `FakeHarnessSession`）、`packages/harness-adapter/test/text-session.test.ts` |

读参考源码时，同时读对应的 test，尤其要确认取消、启动中途失败、原生状态未知、资源关闭和版本差异，而不只是模仿成功路径。

## 不应带入新插件的东西

- `renderer-binding-probe.ts`、`versioned-renderer-adapter.ts`、`protocol-core/src/model-routing.ts` 中按 ID 的分支和旧的专用 codec：只用于旧 Thread 的兼容。
- Claude Code 的 Broker 协议：属于 Claude 自己的运行身份需求。
- 具体的 SDK/RPC、原生权限恢复和历史版本逻辑属于各插件；公共的 Thread 身份、映射事务、交互关联和委派业务属于 Host。

遇到与参考实现不同的原生语义时，先判断公共接口能否表达：能表达，就在插件内转换；不能表达，就按[公共契约扩展](packaging-and-validation.md#公共契约扩展)处理，不要凭名字相似套用原生操作。
