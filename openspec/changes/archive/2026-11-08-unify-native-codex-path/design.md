# Design

## Context

- #772 的 `NativeClientChannel` 已连接共享 `OfficialRuntimeScope`，提供列表、快照、续聊和部分交互。本方案在其上扩展，不重写。
- Host 的 `codexhost/*` 控制方法已有 external 实现。`#inspectThreadUsage`、`#handleThreadPins` 已支持官方 Thread，只是被 `ClientChannelHost` 的归属检查挡住。
- `harness inspect codex` 已返回官方模型目录。`permissionProfile/list` 在 Desktop 0.167.0-alpha.3.2 上实测返回 `:read-only`、`:workspace`、`:danger-full-access`。
- 官方协议提供 `thread/settings/update`（完成由 `thread/settings/updated` 通知确认）、`thread/queue/*`、`thread/compact/start`、`review/start`、`skills/list`。

## Decisions

### 1. Web 不感知所有者，差异只在 Host

Web 继续调用现有 `codexhost/thread/*`、`thread/*`、`turn/*`。`ch-sessions.ts` 中按原生分支的代码全部删除，控件显示由 `HarnessInspection.capabilities` 决定。

`ClientChannelHost.handleClientRequest` 用一张方法到所有者行为的表替代 `nativeMethods`。官方 Thread 的处理：

| 客户端方法 | 官方行为 |
|---|---|
| `thread/read`、`resume`、`turns/list`、`items/list`、`name/set`、`archive`、`unarchive`、`turn/start`、`turn/steer`、`turn/interrupt` | 转发（现状） |
| `thread/queue/*` | 同名转发 |
| `codexhost/thread/queue/send-now` | `thread/queue/start`，带 `queuedSubmissionId` |
| `codexhost/thread/model/select`、`thinking/select` | `thread/settings/update`，等待 `thread/settings/updated` 确认 |
| `codexhost/thread/permission-mode/select` | `thread/settings/update`，`permissions` 使用官方档案 ID |
| `codexhost/thread/commands/inspect` | `/compact`、`/review` 加 `skills/list` |
| `codexhost/thread/command/execute` | `thread/compact/start`、`review/start` |
| `codexhost/thread/pins/set`、`usage/inspect` | 走 Host 现有实现（放行） |
| `codexhost/thread/inspect` | 返回官方配置和能力，移除 `locked: true` 字面量 |

确认等待的逻辑从 Adapter `model-selection.ts` 搬到 Host。官方专属代码放在 `native-client-channel.ts` 或 `codex-runtime/`。如果 `native-client-channel.ts` 超过 800 行，把配置和命令拆成一个同目录文件，仅此一处。

本次不开放 Fork 和回退：它们不在目标范围内，以后另做。

### 2. 目录和新建

- Web 目录在插件列表之外调用 `codexhost/harness/inspect {harnessId: "codex"}`，就绪时加入 `id: "codex"` 分组。`codex` 仍是保留 ID，不做成插件描述符。
- Host 的 `inspectHarness` 对 `codex` 复用委派已有的官方目录实现，`capabilities.configuration.selectPermissionMode` 改为 true，`permissionModes` 来自 `permissionProfile/list`。
- `commit()` 对 `codex` 发送官方模型 Ref，不使用插件路由。
- 无项目时，Host 复用现有默认目录分配，转成 `cwd` 再调用官方 `thread/start`。官方 Thread 不写 Mapping Store 记录。
- `harness-preferences`、`harness-display-settings` 放开对 `codex` 的排除；`WEB_LEADING_HARNESS` 改为 `codex`。图标用 Web 静态资源。

### 3. 官方后台启动

- Desktop 连接带 context 时，把 `{stockCodexPath, arguments}` 写入 `<data>/official-startup-v1.json`，这是唯一新增的持久化文件。文件损坏时按不存在处理。
- Web 先启动时读取该文件，没有则用基线 `-c features.code_mode_host=true`。
- Desktop 接入时参数不同：后台无活动工作则停止现有代，下一次请求按新参数启动；有活动工作则保留并写诊断。不排队等待，不重试。
- `--stock-codex` 缺失时，Host 用 `resolveHarnessExecutable` 查找 `codex`，沿用 Adapter 的 shim 拒绝规则，并检查 `--version` 不低于 0.161.0。该逻辑从 Adapter 的 `command.ts` 搬到 `codex-runtime/`。

### 4. 服务端请求

`observeMessage` 对 `nativeInteraction` 返回 undefined 的请求：有 Desktop 连接时忽略；否则立即回 JSON-RPC 错误，并通过现有 `nativeInteractionError` 投影提示。“有 Desktop 连接”由 `sharedHostDesktop` 的连接计数提供。

已知需要此处理的方法：`item/permissions/requestApproval`、含 `isSecret` 的 `item/tool/requestUserInput`、`item/tool/call`、`attestation/generate`、`account/chatgptAuthTokens/refresh`、`currentTime/read`、`applyPatchApproval`、`execCommandApproval`。规则按“未处理的请求”统一，不逐方法写分支。

### 5. 写入占用

`snapshot()` 的 `thread/resume` 遇到官方 writer 冲突时，退回 `thread/read` 和 `thread/turns/list`，不记入 `#resumedThreads`，并在快照标记不可发送。冲突判定从 Adapter 搬到 Host。发送时官方错误原样返回，Web 显示“请先在另一端关闭此会话”。

### 6. #772 遗留问题

- `thread/archive` 成功或收到 `thread/closed` 时，从 `#resumedThreads` 删除该 Thread。
- `respond()` 投递失败后，记录该请求为结果未知；后续相同回应报错，不返回 `{resolved: true}`，也不重发。

### 7. 删除

- `packages/adapters/codex-cli` 及 `packages/host-runtime/test/codex-cli-harness.test.ts`。
- `surfaces`：manifest 字段、registry、loader 和 `#visibleOn` 等 Desktop 过滤。
- `onSessionPublished`、`refreshNativeThreadCatalog`、`native-thread-catalog.ts` 及 desktop-control 中对应绑定。
- `ImportedThreadNotice.tsx` 和 `openspec/changes/web-codex-as-external-harness/`。
- 旧记录在 `#recordsFor` 和 `ownership` 处按一个常量 `RETIRED_HARNESS_IDS = ["codex-cli"]` 过滤，不写迁移。

## 实施约束

本方案优先最小实现。实施时必须遵守：

- 不新增包、抽象基类、注册表、策略模式、插件式分发、特性开关或配置项。一张方法表加普通函数即可。
- 不为假想需求预留扩展点，不写“未来可支持”的参数。
- 不做兼容层、迁移工具、ID 别名、过渡双入口或版本分支路径。
- 不写重试、退避或队列，除非本文明确要求。
- 除 `official-startup-v1.json` 外，不新增持久化。
- 不顺带重构、改名或调整无关文件。能搬的代码直接搬，不包一层。
- 本文未写明的场景，选择改动最小且符合 spec 的做法，并在交付说明中列出。

## Risks / Trade-offs

- [官方协议变化导致 Web 能力失效] → 仅使用上表方法，失败时显示官方错误；Desktop 更新后的兼容审计沿用现有流程。
- [Desktop 接入时替换后台，中断其他客户端的只读订阅] → 仅在无活动工作时替换，Web 按现有换代逻辑重新同步。
- [`nativeInteraction` 未覆盖的请求被 Host 回错，而 Desktop 刚好在连接中] → 按回错时刻的连接状态决定，不做额外协调。
- [本机 `codex` 与 Desktop 版本行为不同] → 只设版本下限，不做分支适配。

## Migration

无数据迁移。回滚即回退代码，`official-startup-v1.json` 可直接删除。
