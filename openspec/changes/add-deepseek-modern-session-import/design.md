## Context

本变更是 `support-deepseek-harness-protocol-generations` 的 stacked follow-up，假定父变更先落地。它只替代父变更当时的“不导入用户已有未映射 DSH Session”非目标，不改变父变更的 exact release 集合、认证、进程所有权、端口策略、Legacy transport 或 Modern journal 状态机。

Legacy 参考分支 `feat/deepseek-session-import@7f62fd69` 证明了候选字段、Mapping Store 排除、Native Session 唯一性和标准 Thread 恢复的产品语义，但其实现绑定 `sessions.list({})` Host ApiProxy、Composer cwd/prewarm/Fiber、独立 Dialog，以及导入时的 resume → Snapshot → runtime registration。当前入口改为全局设置页，且 Modern Runtime 已能从一条 ready mapping 懒恢复，因此这些实现不应整体迁移。

exact `dsh-v0.1.2-rc.1`（tag commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`）在 `SessionController` 上公开 `@Remote('list')`。Typert 以形参名编码 args，方法形参是 `_request`，所以真实调用是：

```ts
connection.call("session/list", { _request: {} });
```

返回的 `items` 同时包含 live 与 cold Session，按活动时间从新到旧排序。cold 列举不会恢复 Agent。每项包含 `sessionId`、`updatedAt`、`running`、`blank`，可选 `cwd`、`parentSessionId`、`origin: "subagent"` 和 merge-extensible `projections`; title 只来自 `projections.values.title`。

2026-09-04 重新核对 exact rc.1 证据：tag `dsh-v0.1.2-rc.1` 仍指向 `a66e4702047846cdaa10c66c9d3df3951f5ea70d`；源码 `pnpm-lock.yaml` SHA256 为 `E12083149A77F790D39B64D018B6B8745C6A7AA95777ECB73E0A2F5ED5FDD0D9`。隔离 npm compiled artifact 的 lock SHA256 为 `37AF94F193173F1E51BCA1A18A5F437649775953BE4A549466F913A869060ED1`，214/214 个 `@deepseek-ai/dsh*` package 都是 `0.1.2-rc.1`，没有 nested DSH release。compiled `dsh-api-session-controller` 的 Typert metadata 固定 endpoint `session/list`、唯一参数 `_request` 和 `SessionListValue`；实现同时读取 live/cold、按 `updatedAt` 降序且不恢复 cold Agent。

Mapping Store 已经是运行中 Host 的唯一 External Thread metadata 索引。手写 `~/.codexhost/mapping-store/threads/<hostThreadId>.json` 虽然形状可能正确，却会绕过内存索引、Runtime Schema、Store lock、原子替换和 `(harnessId, nativeSessionId)` 唯一检查，因此导入必须通过现有 Repository/Store API 生成同一个文件。

## Goals / Non-Goals

**Goals:**

- 只导入当前本机 CH 实例管理的 exact rc.1 Modern DSH profile 中的普通非空 Session。
- 在 Adapter 信任边界严格、有界地解析 rc.1 `session/list`，不把 DSH wire 类型泄漏到 Host 或 Renderer。
- Host 只信任 Renderer 提交的 bounded Native Session ID，并在 durable write 前用新鲜 native list 复查所有元信息与状态。
- 每个成功导入只创建一个合法 V1 ready mapping；重复点击、陈旧 UI、并发提交和失败不得产生重复或半成品 Thread。
- 导入成功后立即进入标准 Thread surface；历史与后续对话复用现有 Modern resume 管线。
- 设置页保持紧凑、可访问、本地化，并且无论当前 Composer 位于哪个 Host 都只访问 local Host。

**Non-Goals:**

- Legacy `0.1.1-rc.2` Session 导入，或任何其他 Harness 的 Session import/list 抽象。
- Remote Host 导入、外部 Modern Web 附着、凭据共享、默认 3080 之外的端口扫描或进程发现。
- 批量导入、搜索、分页、按 cwd 筛选、Native Session rename/delete/archive、跨 cwd 迁移或完整 Session 管理页。
- 读取 DSH JSONL/SQLite/projection cache/credential store，复制 Transcript、Prompt、Tool output、Diff 或 preview。
- 在导入时调用 DSH create/fork/prompt/cancel/select/command，或打开 Session、恢复 Agent、读取 Snapshot、注册 live Runtime。
- 修改通用 `HarnessAdapter`、Mapping Store V1 Schema、依赖、lockfile 或其他 Harness 行为。

## Decisions

### 1. 候选能力只属于 concrete DeepSeek Modern Adapter

`ModernDeepSeekHarnessAdapter` 在现有 authenticated `ModernRemoteConnection` 上增加一个 DSH-specific list 方法。公共 `DeepSeekHarnessAdapter` Facade 只在其生命周期已经选择 Modern delegate 后转发该方法；选择 Legacy 时返回稳定 `unsupported`，不得调用 Legacy `sessions.list` 或 `open`。

Host 通过窄的 structural capability 取得该方法，不扩展公共 `HarnessAdapter`。Renderer 只看到 SDK-free Shared Contract。这样代际判断仍只发生在现有 selector，Host 不解析 DSH 版本、endpoint 或 event，也不会形成任意 Harness method bridge。

### 2. `session/list` 解析严格、有界且保留可扩展 projection

Adapter 精确发送 `{ _request: {} }`，复用现有 unary envelope、认证、timeout、response byte cap 和 credential redaction。成功 value 还需执行 Session-list 专属校验：

- 外层与 item 使用 exact required/optional keys；item 数量有固定上限。
- Session ID 非空、有界、无 NUL，并且同一响应内唯一。
- `updatedAt` 是 JavaScript `Date` 可表示的非负整数；`running`、`blank` 必须为 boolean。
- cwd 非空、有界、无 NUL且为当前平台规范绝对路径。保留 DSH 返回的精确字符串，使后续 journal header cwd equality 仍可证明。
- `origin` 只接受 `subagent`；可选 `parentSessionId` 只作为 Native lineage metadata，不等同于 Subagent。
- `projections` 外壳必须合法；`values` 作为 DSH merge-extensible JSON 做深度、节点与字节上限检查，但允许未知 key。
- title 只接受有界非空 string；absent/null/不可用 title 降级为 null，不读取历史猜标题。

Adapter 排除 `origin === "subagent"`、`blank === true` 和无效 cwd。普通 Fork Session即使有 `parentSessionId` 仍保留；列表顺序保持 DSH authoritative order。running Session保留给 UI 解释瞬时状态，但不可导入。

### 3. Host 只接受 Native Session ID并做新鲜复查

Renderer list params 为空，import params 只含 `nativeSessionId`。Host 不能接受 Renderer 提供的 cwd、title、updatedAt、running、Model、Thinking、Permission 或 preview。

候选 list 在 Adapter 结果上读取一次 `repository.list()` 并排除已由非 Subagent ready record 映射的同一 `deepseek-harness + nativeSessionId`。import 在任何 write 前再次调用 Adapter list，并要求该 ID 仍唯一存在、仍是可导入普通非空 Session、cwd 仍合法且 `running=false`。Session 消失或不再 eligible 时失败关闭。

相同 Native Session ID 的 import 在一个 Host 内 single-flight，RendererModelClient 也跨设置页 remount 复用同一 pending request。已存在完全相同的 ready mapping 时，重复请求幂等返回现有 Host Thread ID。

实现审查实际复现了两个共享同一 Mapping Store 的 AppServerHost 同时提交同一 Native Session 时，旧的 per-Host-Thread 写队列可让两条 ready record 都通过 Store-wide Native Session 索引校验。因为 Native Session 与 Native Turn 唯一索引本来就是 Store-wide，所有 Store write 改由一个最小共享队列串行；loser 收到 `DUPLICATE_NATIVE_SESSION` 后删除 provisional 并返回 winner。这个修复不改变 Schema 或文件格式，也同时封闭其他跨 Thread 全局索引竞争。

### 4. 导入提交只有 mapping，不打开 Native Session

成功路径固定为：

```text
fresh Modern session/list
→ fresh Mapping Store exclusion
→ createProvisional(new Host Thread ID, native cwd/title)
→ commitNative(exact NativeSessionRef, turnMappings=[])
→ response { threadId }
→ 当前 AppServerHost 连接至多发送一次 thread/started with a notLoaded standard Thread
```

record 使用：

- `harnessId = deepseek-harness`
- `nativeSessionRef = { harnessId, nativeSessionId, formatVersion: 1 }`
- DSH 新鲜候选的 cwd 和 title（无 title 时为空字符串）
- `transportModelIdForHarness("deepseek-harness")`
- `ephemeral = false`
- `historyMode = paginated`
- `turnMappings = []`

`formatVersion: 1` 是 codexhost Native Ref 版本，不是 DSH journal header `version: 0`。Mapping Store 的 created/updated timestamps 表示 Host mapping 生命周期；不为保留 DSH `updatedAt` 扩展 V1 Schema。

provisional 后、ready commit 前的任何失败都删除 provisional。进程若在两步之间退出，Mapping Store 初始化继续按既有规则删除没有 Native Ref 的 creating record。ready commit 后，侧栏导航失败或稍后的 native resume 暂时失败都不得删除用户已确认的 mapping；原生 Session 暂时不可达与 Host metadata 持久化是两个不同边界。

### 5. 历史只在标准 Thread 第一次打开时懒恢复

`thread/started` 只投影 `notLoaded` metadata，不注册 `HarnessSession`。Desktop 打开该 Thread 后沿用：

```text
ExternalThreadRuntime.resolve
→ adapter.open({ kind: "resume", exact nativeRef, cwd, knownTurnRefs: [] })
→ openModernJournal(session/follow + session/page)
→ readSnapshot
→ repository.alignSnapshot
→ persist generated Host Turn mappings
→ register live Runtime
```

这条路径已经验证 header identity/cwd、完整 journal 连续性、Model/Thinking/Permission state 和 Native Turn identity。导入无需提前重复这些检查。若 DSH Session在 mapping 提交后被删除，标准 resume 返回现有 session-not-found 错误，mapping 保留供原生数据恢复后重试或由用户按普通 Thread 管理流程删除。

### 6. 设置页使用一个本地、紧凑页面

生产 registry 在 Connections 与 Updates 之间增加 `session-import` 页面。页面始终存在以保持导航稳定，但只有 `modelClientForHost("local")` 可提供两个 method-specific 操作；Remote Host、缺失 request bridge、Legacy delegate 或 unavailable Modern DSH 显示明确 unavailable 状态，不切换到当前 remote Composer 的 client。

页面不嵌套 Dialog。顶部只有标题、简短说明和 Refresh；候选每行显示 title fallback、格式化更新时间、单行 cwd、短 Session ID、running 状态和一个“导入并打开”按钮。blank、Subagent 和已映射 Session不会出现。running 行保留但 action disabled，以便用户知道关闭活动后可以刷新。

页面只维护 `loading | unavailable | empty | error | ready | importing` 六种状态，复用 `RendererSettingsPageScope.runLatest` 使导航、关闭、刷新和 locale remount 后的旧结果不能修改当前页面。提交期间禁用重复操作。所有文本使用现有 English/简体中文 catalog，状态使用 ARIA live/alert，键盘 focus 和窄窗口布局沿用 settings shell。

成功后 Host 返回 committed result，并让每个参与竞争的 AppServerHost 连接各自至多收到一次 `thread/started`，所以任一窗口都能看到 winner。Renderer 复用从 Fork 控件抽出的 Host-qualified sidebar opener，只匹配 `hostId=local + returned threadId`，关闭设置并打开该行；generic Fork 继续保留原有 Host-neutral opener，不能被本地导入硬编码破坏。超时或 stale page 只清理 observer/timer并显示本地化可恢复错误，不得再次 import 或撤销 ready mapping；Thread 保持可由下一次标准侧栏/list刷新发现，用户可手动打开。

### 7. 错误与竞争保持可恢复

- invalid params/identity → JSON-RPC invalid params，且不调用 Adapter。
- Legacy selected → non-retryable unsupported，且不调用 Legacy Session API。
- DSH unavailable/auth/process exit → 使用现有 sanitized Adapter error，不回显 token/cookie/launch URL。
- malformed/oversize list → protocol error，不返回部分候选。
- running → retryable busy；用户停止原生活动后刷新。
- Session在 list/import 之间消失或变得不 eligible → unavailable/not-found，不写 mapping。
- Mapping Store I/O → persistence failure；已创建 provisional 尽力清理。
- double click/remount → RendererModelClient coalesce；Host nativeSessionId single-flight；Store-wide write queue 与 Native Session uniqueness 是最终兜底。
- response 后 Renderer context 失效 → 不导航；durable mapping 和标准 Thread 保留。

## Validation Evidence

2026-09-04 Windows Gate 使用上述 exact rc.1 compiled artifact 和隔离 `DSH_HOME`：bootstrap token 与 Cookie 只在进程内用于认证，不写日志；真实 HTTP Remote 精确发送 `session/list` + `{ _request: {} }`。Gate 建立并观察 idle root、blank、Subagent、running 和普通 Fork 五类 Session，确认 Adapter 排除 blank/Subagent、保留普通 Fork 和 running 状态。随后通过公共 `DeepSeekHarnessAdapter` 与 Host importer 导入 idle Session，证明只生成一条 ready mapping、重复导入返回同一 Thread、导入前后 DSH Session artifact tree hash 相同。第一次 `ExternalThreadRuntime.resolve()` 才恢复完整历史并补齐 Turn mappings，之后的新 Turn 继续同一 Native Session。所有 managed DSH 进程、随机端口和临时目录均完成 teardown。

exact `0.1.1-rc.2` compiled artifact 负向 Gate 同时通过：Legacy inspect、create 和 resume 保持 ready；导入路径的 list/import 均返回 Modern-only unsupported，Mapping Store 保持空，进程退出且端口释放。Hermetic 竞争 Gate 另覆盖两个 importer 和两个 AppServerHost 共享一个 Store，确认最终只有一个 ready winner，而每个连接只通知一次同一 Thread。

提交态最终运行 `npm run check` 通过：Prettier/Rustfmt、全仓 ESLint与 boundary check、TypeScript build/typecheck、207 个 TypeScript 测试文件（2234 passed、18 skipped）以及 129 项 Rust 测试全部成功；该命令不包含 Playwright。父 PR #144 当时仍为 OPEN/CLEAN，因此按 stacked 分支约定只记录 `upstream/main` 更新，不在本阶段 rebase。

## Risks / Trade-offs

- [mapping 提交与首次打开分离] → 导入可以在原生 Session随后消失时留下暂时不可打开的合法 mapping；不为此复制历史或删除用户已确认的关联，标准 resume 会如实报告错误。
- [DSH list 没有分页] → 使用固定 response/item/work bounds，超限整体失败；只有 rc.1 后续提供受验证分页协议时再增加分页。
- [running 只是瞬时状态] → 提交前重列仍不能形成 lease；首次打开的 native busy/identity 结果继续权威，不能猜测 attached 状态。
- [设置页触发 Adapter selection/startup] → 与现有 Harness inspection 生命周期一致；只允许父变更已经证明所有权的本地 managed Modern process，不附着外部端口。
- [导入后的 Host 时间不等于 DSH 活动时间] → 候选列表展示真实 DSH `updatedAt`，ready mapping继续使用既有 Host metadata timestamps，避免 Schema 迁移。
- [Store-wide 写队列降低并行写吞吐] → Mapping Store 写入短小且全局身份索引必须原子；只有实际测得写入吞吐成为瓶颈时，才按不相交索引分片。

## Migration Plan

无持久化格式或 DSH 数据迁移。已有 DeepSeek mappings 和其他 Harness records保持不变；新导入产生普通 V1 ready record，旧版本 codexhost 仍可按已有 Native Ref 恢复它。

本 stacked branch 在父 PR 合并后 rebase 到 upstream main，再重复 exact rc.1 与 Legacy negative Gate。回滚删除两个固定方法、Adapter list seam 和设置页即可；已经导入的 ready mappings仍是合法 External Thread metadata，不应随功能回滚删除。
