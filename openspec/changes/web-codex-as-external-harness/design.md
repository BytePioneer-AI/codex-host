# Design

## Context

其他 Harness 在 Web 中的路径：浏览器 → web-server `ChSessions` → client channel → 共享 Host `AppServerHost(externalOnly)` → Mapping Store → Adapter。GUI 与 Web 共用这一套外部 Thread 运行时。

Web Codex 的路径：浏览器 → `MixedSessions` → `RemoteCodexSessions` → `/v1/web-codex/*` → `SharedWebCodexOwner` → `IsolatedSessions` → 单独加载的 `web-codex` 插件注册表 → Codex Adapter。约 4600 行生产代码只服务于这条路径。它存在的原因是 `codex` 身份保留给官方路由，Codex 无法作为外部 Harness 进入 AppServerHost。

已核实的事实：

- Mapping Store 的原生会话键为 `harnessId + nativeSessionId`，新身份不冲突。
- 外部 Harness 路由的身份空间是开放的（`ExternalHarnessId = string`），新增 Harness 不需要改 protocol-core 的路由表。
- Host 已区分 Desktop 请求与 client channel 请求：client channel 经 `handleClientRequest` 进入并带 `"client"` 来源，并且已拒绝以 `codex` 新建。
- 委派协调器能把父 Thread 解析为 official 或 external。
- `steer?` 与 `readHistory?` 只被 `IsolatedSessions` 消费；外部运行时的 steering 不调用它们。
- 两个被取代的 change 从未归档，`openspec/specs/` 中没有 Web Codex 相关需求。

## Decisions

### 1. 身份与打包

- 目录 `packages/adapters/codex` 改为 `packages/adapters/codex-cli`，包名、manifest `id` 为 `codex-cli`，显示名为 "Codex CLI"，`surfaces: ["web"]`。
- 加入 `scripts/release/harness-plugins.json` 的预装列表，与其他插件相同。
- 保留 `harnessPluginIdSchema` 对 `codex` 的保留；删除 `HarnessPluginScope` 的 `web-codex` 分支，`isHarnessPluginInScope` 只剩外部 scope 与 usage 插件的既有规则。
- 继续复用 `@codexhost/adapter-codex-usage` 的会话用量读取，与现在一致。

### 2. Adapter 能力边界

| 保留 | 删除或修改 |
|---|---|
| inspect（模型、推理强度、权限模式目录） | 去掉 `execFileSync --version` 的同步探测，改用通用安装检查 |
| create / resume，Turn、interrupt | `thread/start`、`turn/start` 只在用户选择权限模式时下发 `approvalPolicy` 与 `sandbox`；删除写死的 `sandboxPolicy` |
| 审批与 `requestUserInput` 交互 | 未支持的原生请求继续立即回错，不挂起 |
| `/compact`、`/review` 原生命令 | 不新增 Host 侧命令 |
| `readSnapshot`、`sessionImport` | 删除 Adapter 级 `readHistory`；导入走外部运行时既有的 resolve → resume → `readSnapshot` |
| shim 拒绝 | 删除强制 `--codex-command` 绝对路径；用 `harness-discovery` 与 launch settings 解析，和其他 Harness 一致 |
| `CODEX_HOME` 或 `~/.codex` | 删除 nativeRef 中的 `codexHome` locator 及其比对，那是隔离 owner 的约束 |
| | 删除 Session 的 `steer` 实现 |

权限模式仍使用三档（只读、自动、完全访问），因为外部 Harness 契约要求提供权限目录，而 app-server 没有列出预设的接口。三档只映射到原生的审批策略与沙箱模式名，细项交给用户原生配置。

### 3. Desktop 侧可见性

在 shared-contracts 的 manifest schema 中加 `surfaces`，Host 加载时据此形成每个 Harness 的界面集合。Host 只在 Desktop 分支过滤，client channel 分支不过滤：

1. `codexhost/harness/plugins/list` 的 Desktop 回复排除仅 Web 的插件描述。
2. Desktop 的 `thread/start`：路由到仅 Web 的 Harness 时返回明确错误。
3. Desktop 的 `thread/list` 合并外部行时，排除仅 Web Harness 的 Thread。
4. 推送给 Desktop 的外部 Thread 事件，排除仅 Web Harness 的 Thread。
5. 委派：父 Thread 为 official 时，`listHarnesses`、`inspect`、`start` 排除仅 Web 的 Harness，`start` 返回 `HARNESS_NOT_FOUND`。

过滤只依赖 Harness 的界面集合，不出现 `codex-cli` 字面量。

### 4. 删除范围

| 包 | 删除 |
|---|---|
| host-runtime | `web-codex-owner.ts`、`web-codex-harness.ts`；`shared-host-service` 中的组装；`client-channel-server` 的 `/v1/web-codex/*`；`ClientChannelEvents.webCodexChanged` |
| shared-contracts | `web-codex-owner.ts`；client channel 的 `web-codex-changed` 事件；偏好设置中的 `web-codex` scope |
| desktop-control | `configureWebCodex`、`webCodexRequest`、`webCodexStream` |
| web-server | `remote-codex-sessions.ts`、`mixed-sessions.ts`、`mixed-drafts.ts`、`session-source-endpoints.ts`；`main.ts` 的 `--codex-command`、`--codex-home` 与 `codexEnabled` 分支；`workspaces.ts` 的 local organization 分支；`harness-preferences.ts` 的 codexScope；`ch-host-client.ts` 的 `webCodex` |
| session-runtime | `sessions.ts`（`IsolatedSessions`）、`organization-store.ts`、`session-data-store.ts` 及只服务于它们的 `contracts` 类型 |
| harness-adapter | `HarnessSession.steer?`、`HarnessAdapter.readHistory?` 及 Loader 中对 `readHistory` 的形状检查 |
| openspec | `changes/unify-gui-web-session-ownership/`、`changes/add-web-codex-authentication/` |

保留 `session-runtime` 中共用的 `projector`、`session-log`、`usage-metering`、`usage-projection`、`session-presentation`。包名是否调整不在本次范围。

Web 的 `main.ts` 只组装 `ChSessions`；Codex CLI 是否在 Web 中启用，与其他 Harness 一样由 `--harness` 和 Web 显示设置决定。

### 5. 旧数据

`<data>/web-codex/` 不读取、不删除，也没有迁移入口。当前分支未发布，不提供兼容层。

## Risks / Trade-offs

- [同一原生会话被 GUI 官方 Codex 与 Codex CLI 同时打开，结果不确定] → 与现有方案相同，不新增互斥；在功能文档中说明由用户避免同时使用。
- [Turn 进行中追加消息从原生同 Turn 追加变为通用 steering] → 与其他 Harness 一致；需要时另行提案外部运行时的通用原生 steer。
- [Desktop 过滤遗漏某个入口，GUI 仍可见 Codex CLI 或其 Thread] → 为五个过滤点各写回归测试，并做一次 Desktop 实机检查。
- [过滤代码触及 Desktop 投影，影响其他 Harness] → 回归现有外部 Thread 列表、选择器与委派测试。
- [删除隔离运行时后丢失只有它提供的 Web 行为（Web 自建工作区与 local pin/archive、草稿双来源）] → Codex CLI Thread 改用外部 Thread 已有的工作区、pin、archive 投影，与其他 Harness 一致。

## Migration

无数据迁移。回滚即回退代码；本变更不改写 Mapping Store、官方 Codex 数据或 `<data>/web-codex/`。
