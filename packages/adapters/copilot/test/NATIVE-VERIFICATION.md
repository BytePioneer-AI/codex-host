# Copilot 原生验证

2026-10-22，本机 macOS arm64 / Node 24.18.0；官方 SDK 1.0.25、独立 npm CLI 1.0.102，协议 3，local。CLI 经用户明确授权安装到当前 Node 的全局 npm prefix；所有请求使用显式 CLI 路径、headless stdio、`mode: copilot-cli`、`useLoggedInUser: true`。没有改变 HOME/COPILOT_HOME、读取凭据或下载 SDK 自带 runtime。SSH、Linux、Windows 未实测。

## G1：启动和认证（部分）

- 初始公共 discovery 未命中 CLI。VS Code 扩展不是本次 SDK 的 headless 入口。
- 安装后 `resolveCopilotExecutable` 命中当前 nvm 的 `bin/copilot`，`--version` 和 SDK `getStatus` 都为 1.0.102。
- `getAuthStatus`：`isAuthenticated: true`、`authType: gh-cli`。排除子进程的 Token 环境覆盖后仍为 gh-cli。未声称为 Copilot OAuth 存储登录。
- 查询状态、认证、模型前后的原生 Session ID 集合相同，`stop()` 返回空错误数组。没有调用认证交互接口。
- 使用无效的合成环境覆盖（含 PAT 外形标记），原生仍选择 gh-cli 且可执行；这不能证明有效环境 Token 的优先级。有效 Token 覆盖、Copilot 自身存储 OAuth、无任何登录的真实 OS 用户环境尚未验证。
- 原生负对照：仅在探测 Client 中使用 useLoggedInUser=false，排除已知 Token 环境覆盖，getAuthStatus 返回 false/无 authType，stop 无错误，未创建 Session 或触发登录；生产连接仍固定 true。该负对照不冒充完全未登录的 OS 用户实测。
- 可复跑的只读检查：先 `npm run build --workspace=@codexhost/adapter-copilot`，再 `npm run probe --workspace=@codexhost/adapter-copilot -- --without-auth-overrides`。探测父进程只接收白名单 IPC 结果，SDK 原始 stderr 不进入诊断。

## G2–G4：最小实验

- `createSession` 不发消息时 Session 列表没有新增，但 `~/.copilot/session-state/<本次生成的 id>` 目录存在。单用列表无法验收预热。
- 草稿 `setModel(gpt-6-luna)` / `model.getCurrent` 确认选择；`permissions.setMode/getMode` 确认 manual。`disconnect` 后仍有磁盘目录；显式 `deleteSession` 只删除本次未提交草稿后，目录不存在。
- 两轮 PROBE_ONE / PROBE_TWO 均完成。`user.message.messageId` 与持久事件一致；重复 `getEvents` 完全相同，冷 `resumeSession` 保留既有根消息 ID，追加历史不改变旧 ID。
- 文本流中调用 `abort`，收到持久 `abort` 和临时 `session.idle { aborted: true, mode: interactive }`，随后同会话完成 AFTER_CANCEL。
- 原生 shell 审批等待、ask_user 等待、sleep 工具执行时分别取消，均出现上述 idle 确认；每次随后完成 CONTINUED。取消审批/提问时同时解除 SDK callback Promise。SDK `sendAndWait` 在已确认取消时抛错，这不是取消失败。
- 不以 `assistant.turn_end` 作为用户 Turn 结束；不以 `abort()` RPC 返回作为取消终态。`session.idle` 不持久，历史缺乏可靠终态时返回 unknown。
- 该组真实样本的所有根消息均有 messageId。字段缺失时拒绝生成成功身份，负向用例为合成测试，不是原生已复现的缺失事件。
- Fixtures：`fixtures/basic.json`、`lifecycle.json`、`interaction.json`。仅保留用户/助手可见消息、工具及必要身份/用量字段；不包含 system、hook、内部模型请求、账户/配额数据。

## G5：派生（部分）

- `sessions.readPersistedEvents` 分页完整读到原有消息；重复消费 cursor 返回 expired/hasMore=false，不能作为空历史成功。
- 以第二根 user.message 的事件 ID 作为排他边界 Fork，只保留第一根逻辑消息；无边界 Fork 保留全部根消息。
- 以第一根 user.message 为排他边界得到新身份、零根消息；副本设置并读回 gpt-6-luna，成功执行 EMPTY_FORK_CONTINUES。
- 派生操作前后源的完整持久事件 JSON 相同；没有执行文件回滚。测试副本经原生 deleteSession 清理，目录确认不存在。
- Adapter 原生测试验证第一轮 checkpoint 在追加第二轮后仍精确保留第一轮、副本续写不改变源、Rollback 两轮到一轮及一轮到空前缀。本机 assisted 权限配置失败时，失败副本从原生列表删除，源快照保持不变。活动源的拒绝另有公共 Adapter 合成测试。

## G6–G7：配置与用量（部分）

- manual → allow-all → manual 的 setter 和读回一致；assisted 在当前环境返回 success=false，仍为 manual，不能报告选择成功。
- 早期低层 setter 可暂时读回 gpt-6-luna/high，但完整往返显示 modelId 随后变为 auto，reasoningEffort 同时消失。该结果不能证明账号可选择 gpt-6-luna，也不能据此归因为通用 Thinking 持久性故障；原因和修复见下方专项排查。
- 本机 SDK listModels、直接 models.list 以及 session.model.list(skipCache=true) 的具体模型数组均为空。CLI /model 明示当前 Free 账号仅支持 Auto；headless 目录省略该虚拟路由。Adapter 按原生 Copilot 上下文提供 Auto，不补造具体模型或 effort。
- `session.usage_info` 提供上下文占用；持久 usage_checkpoint 和 `usage.getMetrics` 提供累计 token 数据。`assistant.usage.cost` 是原生请求计费字段，不当成 USD。nano-AIU 暂不转换为 credits，直到明确换算依据；不显示估算货币。
- 无人值守创建使用原生 allow-all setter 并确认 readback、sandboxConfig.enabled=false 和托管 sandbox 状态；原生工具实际运行没有进入审批回调。allow-all 跨冷恢复保留，Session 环境在 create/resume 均由真实 shell 布尔检查确认。创建时显式冲突权限被拒绝。
- SDK 不注册提问回调时，原生目录确实不含 ask_user；生产实现仍注册提问/表单回调，遵守公共委派的人接管语义，不把全权限当成禁用提问。用户后续可实时切换权限。
- 真实 SDK 输入未经过 Host turn.start 时，Adapter 产生一个自主 Turn，终态和历史 NativeTurnRef 一致；见 autonomous.native.test.ts。Autopilot/Plan 模式目前明确拒绝，不能据此声称已支持这些模式。
- 原生 async shell 测试观测到后台 task 变更、assistant.idle 后继续工具读取、最终 session.idle；最终原生 task list 为 completed。Adapter 对 task invalidation 立即保留租约，直到原生新快照；完整 Subagent Transcript 属于 P2。
- 原生 history.compact 对测试副本成功，移除 7 条模型上下文消息后，5 个既有根 messageId 保持相同；历史保留 compaction_start/complete，旧分页 cursor 仍为 ok。
- 原生 apply_patch 实际创建文件并返回 fileEdits 与 detailedContent unified diff；磁盘内容符合探测输入。fixtures/file-change.json 保留脱敏后的实际 diff，投影只接受匹配已提交路径的原生 diff。
- 原生 ui.elicitation 的 integer + array 表单成功经过 SDK 回调并回传数字/多选；生产映射另有非法数值、重复/取消及字段约束测试。URL 形式尚未实测浏览器往返，当前明确拒绝。

## 公共 Adapter 与交付

- 直接使用 Adapter 的 inspect/create/execute/readSnapshot/close/resume：两轮真实回答 ADAPTER_ONE / ADAPTER_TWO，实时和历史回答一致，冷恢复同身份成功。
- 合成竞态测试与真实样本回放分别命名。测试通过不能替代原生未覆盖的行为。
- 真正的公共 Host Coordinator 已验证首轮、续轮、busy、read/wait、取消、原生提问经 Desktop 协议回答、提问等待期间 manual/allow-all 实时切换，以及关闭 Host 后用持久映射续跑并通过原生工具检查 Thread 环境。官方 Codex 对端是合成 fixture；Copilot 插件/CLI、模型请求和 Host 路由是真实执行，不是 UI 实测。
- 公共 thread/rollback 也已原生验证：保留 Host Thread 和前缀 Host Turn ID，将 NativeSessionRef、NativeTurnRef 和 Checkpoint 换绑到新会话，精确去掉最后一轮，随后完成提问并在 Host 重建后续跑。原生操作采用 45 秒有界等待；合成 Host 夹具默认的 2 秒等待不能覆盖该操作。
- 真实 Loader 和仓库外 Bundle 通过；actual macOS arm64 payload 位于 build/release/0.13.3/macos-arm64/payload，通过文件/许可证校验。使用 payload 自带 Node 24.13.1 在仓库外导入插件成功，显式缺失 CLI 返回 notInstalled；不借用 workspace node_modules。
- 实际安装检查返回 currentVersion=latestVersion=1.0.102、canUpdate=true、updateAvailable=false。没有执行真实 CLI 更新；隔离 npm 安装 fixture 验证只更新选中的 prefix 并合并并发更新。
- Desktop 真实 UI、SSH、Linux/Windows 仍未验收；未运行 npm start，没有推送、合并或发布。

补充 G5：对实际包含文件修改的测试源，先把测试文件改为 CURRENT，再通过 Adapter 回滚到空前缀；文件仍为 CURRENT，源完整持久事件保持相同，副本为零 Turn。没有用文件回滚实现历史操作。

原生 SDK 连续 enqueue 探测得到 idle、queued 两条 user.message 和最终一次 session.idle。公共 Adapter 不使用该隐式排队：第二个 Host start 在忙碌时拒绝。隐藏的 queued/steering 注入作为原逻辑 Turn 的别名处理；空闲启动的隐藏根消息保留身份但不显示内部输入。外部可见 steering/并发根输入不被伪装成 Host 成功操作。

临时完整 SDK 事件副本已清理；仓库保留按字段白名单导出的 fixtures，不包含 system/hook/内部请求/账户配额数据。

## 模型目录专项修复前的检查（2026-10-22）

- `npm run typecheck`、`npm run lint`：退出码 0。Prettier 对全部改动代码/JSON 检查通过；Markdown 按仓库配置忽略。
- 聚焦回归命令：`npx vitest run --config tests/vitest.config.js packages/adapters/copilot/test packages/host-runtime/test/installed-harness-plugins.test.ts packages/host-runtime/test/app-server-host.copilot.real.test.ts packages/host-runtime/test/app-server-host.projection-3.test.ts tests/release/host-bundle.test.mjs tests/release/payload.test.mjs`。结果 132 通过、6 跳过（17 文件通过、3 文件跳过）。跳过为 4 个需显式启用的 Copilot 原生用例、1 个 Windows 专属用例及 1 个未配置真实命令的 OpenCode 用例。
- 补充原生命令：`CODEXHOST_COPILOT_NATIVE_TEST=1 npx vitest run --config tests/vitest.config.js packages/adapters/copilot/test/native.test.ts packages/host-runtime/test/app-server-host.copilot.real.test.ts`。结果 3 通过，92.20 秒。自主输入用例在此前启用原生标志的运行中通过。
- 早期 high 差异的最初归因已由下述专项排查纠正；初始化资格校验与读回保护均已补齐。Host 回滚测试改用适用于原生操作的等待预算，并验证前缀身份随新 Native Session 换绑；没有修改公共 Host 实现。
- 使用 `prepareReleasePayload({target:releaseTarget("macos-arm64")})` 重建最新源码，实际 TypeScript/Renderer/Rust release 构建和 payload 校验成功，没有启动 Desktop 或制作安装器。将 payload 内 Copilot 插件复制到仓库外临时目录，使用其 `runtime/node`（24.13.1）、空 NODE_PATH 加载，显式不存在的 CLI 返回 notInstalled，退出码 0；临时目录已清理。
- 修复前的只读探测为 SDK 1.0.25 / CLI 1.0.102 / 协议 3 / gh-cli，modelCount=0，sessionsUnchanged=true，stopErrorCount=0。现有认证可继续使用，无需再次登录。
- `openspec validate add-copilot-native-harness --strict --json` 及 `git diff --check` 通过。7/11 项完成；未完成项保留在 tasks.md，没有推送、合并或发布。

## 模型目录与 Thinking 专项排查（2026-10-22）

结论：具体模型空目录是当前账号的 Auto-only 资格，而非 SDK 丢失具体模型；此前 Thinking 变化来自不可选的具体模型在执行时被原生切回 Auto。Adapter 缺少虚拟 Auto 条目与配置资格校验，是可修复的接入问题。

1. 对照同一官方 CLI、同一 HOME/登录、临时工作目录，分别调用 SDK `listModels()`、无缓存的 `client.rpc.models.list({})`、`session.rpc.model.list({skipCache:true})`，具体模型均为 0。原生结果没有 `auto` 元数据；session 结果仍公布 `kind:copilot` 的 provider。SDK 缓存不是本次空数组的原因，但不能用该首次缓存实现显式刷新。
2. 原生 TUI `/model` 显示 “Your Copilot Free plan currently includes only Auto”，且唯一可选项为 Auto。未更改选择或持久配置，退出 TUI。此行为与[官方套餐说明](https://github.com/github/docs/blob/main/content/copilot/get-started/plans.md)及 [CLI 1.0.55 发布说明](https://github.com/github/copilot-cli/blob/main/changelog.md)一致。认证状态仍为 gh-cli；没有要求新登录或读取 Token。
3. 直接 SDK 对照（未经过 Adapter）：`gpt-6-luna/high` 在创建和 setter 后暂时读回一致；发送一条无工具请求后，读回是 `modelId:auto`、无 reasoningEffort。此前只关注 effort 字段，遗漏了同时发生的模型变更，不能宣称为 SDK/CLI 的通用 Thinking 持久化故障。
4. 原生 `createSession({model:"auto",reasoningEffort:"high"})` 明确拒绝：`Reasoning effort is not supported when using the "auto" model.` 另一方面，低层 `setReasoningEffort(high)` 能存储该值且执行后仍可读回；其官方类型注释明确要求调用方先验证模型支持的 levels。存储成功不等于受支持的推理配置。
5. Adapter 的 `readModels` 区分原生具体模型与虚拟 Auto：无会话检查只在有效 GitHub 原生认证下提供 Auto；会话目录以原生 Copilot provider/Auto 元数据为依据。API-key 或没有 Copilot provider 的目录不因此获得 Auto。不会从内置具体模型表补齐选项，也不声明 Auto 的默认模型或 effort。
6. 显式 Model/Thinking 选择刷新会话目录；初始 Model 在创建前校验，创建后再按会话目录确认。Thinking 使用独立的 `model.setReasoningEffort`，仅允许该模型公布的值并读回。原生存储的未公布 effort 不投影为有效 Thinking。非法请求不提交用户输入、不静默替换成 Auto，失败草稿被清理。
7. `configuration.native.test.ts` 验证 Auto 目录、inspect 无会话副作用、非法初始 Model/Thinking 无草稿残留、非法实时选择保持 Auto、两轮执行及冷恢复。`native.test.ts` 和自主输入测试改为选择实际可用的 Auto，并验证派生后配置；不再使用无资格的具体模型作为成功配置样本。
8. 当前账号没有可选的具体模型/Thinking 档位；付费账号对应的多模型与 Thinking 活动期切换/继承矩阵仍未实测。这是验证覆盖范围，不是本次空目录或状态变化仍原因不明。


## 专项修复后的最终检查

- `CODEXHOST_COPILOT_NATIVE_TEST=1 npx vitest run --config tests/vitest.config.js packages/adapters/copilot/test packages/host-runtime/test/app-server-host.copilot.real.test.ts packages/host-runtime/test/installed-harness-plugins.test.ts tests/release/host-bundle.test.mjs tests/release/payload.test.mjs`：21 文件通过，95 通过、2 跳过，90.43 秒；包括 5 个真实 CLI 用例。跳过为 Windows 专属 npm 启动及未配置真实命令的 OpenCode 检查。
- `npm run typecheck`、`npm run lint`、改动文件 Prettier、`git diff --check`：通过。
- 最新源码 macOS arm64 payload 重建及校验成功；仓库外复制 Copilot 插件，使用随包 Node 24.13.1、空 NODE_PATH 和显式本机 CLI 检查，返回 ready、模型标签 [Auto]、退出码 0。临时搬移目录已删除。
- 更新后的只读 probe 返回 Adapter modelCount=1/modelIds=[auto]，sessionsUnchanged=true、stopErrorCount=0；认证仍为 gh-cli。它区分原生具体数组和 Adapter 提供的原生 Auto 路由，未读取凭据、创建检查会话或请求模型。
- OpenSpec 严格验证通过，39 行能力清单和 tasks 同步。当前请求涉及的原因已定位并修复接入问题；付费账号的可选 Thinking 原生矩阵尚未覆盖，不用合成结果冒充实测。



## 初始模型预选（最终方案）

- Host 的目录已有 Auto，但缺少 defaultModel，既有公共 Renderer 因此没有可用初始选择。曾为未知默认值扩展公共 Renderer，用户明确希望直接选定可用模型后，该方向及相关生产修改已撤回。
- Copilot Adapter 的 modelCatalog 为非空目录提供初始选择：Auto 优先，否则原生目录第一项。只有 Auto 时直接预选 Auto；已有用户偏好仍由原公共 Renderer 优先保留。该选择不冒充原生 effectiveModel，不改 CLI 用户配置。
- 浏览器验收使用原版公共 Renderer，接入实际 Copilot inspection；初始应显示 Auto，直接点击真实 Send 按钮，路由携带该初始模型与 manual 权限，再通过受控桥接交给真实 SDK/CLI。没有手动点选模型步骤；不是修改用户 Desktop 对话或自动替用户发送消息。
- 相关单测覆盖单项 Auto、多项含 Auto、多项无 Auto、单个具体模型及空目录。原生配置测试使用 inspection.catalog.defaultModel 创建并确认会话，继续验证两轮和冷恢复。

- 最终选择策略验证：聚焦回归 77 通过、5 跳过（4 个原生开关用例及 1 个未配置的 OpenCode 检查）；原生配置相关 8 项通过；浏览器初始预选 Auto 后直接发送的真实 CLI 用例通过，返回 AUTO_PRESELECTED_SEND_OK。Loader 首次运行与插件目录重建重叠读到空目录，构建结束后串行复跑通过。
- typecheck、lint/边界、格式、OpenSpec 严格验证、git diff --check 和 macOS payload 构建/校验通过。git diff 确认 packages/renderer-extension 无改动。运行中 Adapter 不热替换，新初始选择随下一次源码启动加载；现有用户选择不被重置。

## 审查竞态修复（2026-10-23，合成测试）

两项 P1 审查结论均复现。修复前先加入永久用例：8 个取消交错组合和 1 个跨轮 Diff 用例失败；另 3 个孤立 completion/历史归属用例失败。没有使用真实 CLI 请求制造这些竞态。

- 取消用 Promise.withResolvers 明确分开原生 idle 确认与 abort RPC 返回：旧轮终态后建立新轮问题或审批，再完成或拒绝旧 RPC。覆盖 Host 输入、原生自主根消息，以及复用 Host Turn ID 的独立执行。旧问题关闭一次，新交互仍可回答，旧失败不 fault 新轮；当前执行的未确认取消失败仍正常 fault。RPC 受理本身不发布取消终态。
- 工具用固定 old-tool 起始后取消，下一轮注入旧 partial/progress/shell_output/complete 和重复 start，附匹配路径的原生格式 unified diff。第二轮没有旧 FileChange，也没有孤立 sourceItemIds；新工具的正常 Diff 保留。
- 历史使用 toolCallId 到起始所属 reducer 的映射，不按最新根消息归属 completion；未知起始记录不产生 Diff。已知工具的后到结果可以补齐原轮历史事实，同时保持父轮 cancelled/failed，不能将其归入新轮或凭此改变父轮终态。
- 后台正向用例覆盖 assistant.idle 后仍活动的工具完成、后台租约、以及下一根消息后才到达的后台结果。实时已终结轮不追加 Item，持久历史仍在原轮保留后到结果；没有把退休过滤当成丢弃全部后台完成事件。
- 聚焦命令：`npx vitest run --config tests/vitest.config.js packages/adapters/copilot/test/session.test.ts packages/adapters/copilot/test/history.test.ts packages/adapters/copilot/test/projection.test.ts packages/adapters/copilot/test/interactions.test.ts packages/adapters/copilot/test/derivation-errors.test.ts packages/adapters/copilot/test/background.test.ts packages/adapters/copilot/test/elicitation.test.ts packages/adapters/copilot/test/file-changes.test.ts`。结果 8 个文件、57 项通过。
- 本节是合成竞态与已有原生 fixture 回放记录，不是新的原生验收；未创建新原生会话或委派会话，未启动 Desktop，未推送、合并或发布。


## 账号额度与 AI Credits（2026-10-23）

- SDK 1.0.25 / CLI 1.0.102、macOS arm64、原生 gh-cli 认证。account.getQuota 成功返回额度，但兼容字段仍叫 Requests，且带 tokenBasedBilling；生产投影不据字段名猜测单位。
- quota.refresh 的 providerQuotas 实际返回 GitHub Copilot/chat、unit=ai_credits、quantityKind=authoritative_budget、observationKind=account_snapshot、acquisitionStatus=succeeded，包含 consumed/entitlement/remainingPercentage。金额与百分比保留各自原生精度，不从已四舍五入的已用量重算百分比；没有 cadence 时周期为 unknown。
- 新鲜账号查询创建独占只读用途的临时草稿，禁用配置/skills/hooks 发现，不发送输入；查询后原生 disconnect/delete/stop。account.native.test.ts 确认临时 session-state 目录不存在，且账户额度被公共 schema 接受。
- 会话 totalNanoAiu 按官方 TokenPriceUnit 的 nano_aiu 定义 /1e9 转换 AI Credits，真实模型请求已验证输出和原生累计金额一致。partial/unavailable 不作为完整花费，旧运行时缺少完整性字段时只采用正的原生累计值；不将 premium request cost 或 Token 数换算为 Credits，不计算 USD。
- inspectAccount 始终新鲜读取；credits/refreshCredits 为 15 秒缓存，刷新先移除旧值，前后原生认证不同则丢弃结果。并发合并、未登录不建草稿、关闭竞态和清理失败重试有聚焦测试；缓存不声称检测到外部账号变化的零延迟。
- 真实隔离插件经公共 codexhost/harness/accounts/sources 和 accounts/inspect 返回账号额度；官方 Codex 对端仍为测试 fixture，Copilot/SDK/额度请求是真实执行。这是 Host 协议验收，不是重启后的 Desktop 设置页实测。
- 聚焦回归 120 通过、7 跳过；定向原生账号/Host 检查 2 通过、1 个无关对话用例按名称过滤跳过。typecheck、lint/边界通过。首次原生测试在 finally 重复删除已经清理的额度草稿而失败；清理夹具修正后通过，没有把该次失败计为通过。
- 本次仅新增 Adapter 账号查询/额度投影和会话 Credits，复用公共账号与用量接口；没有修改 Host/Renderer 生产代码，没有额外登录、推送或发布。
- 必要静态检查：`npm run typecheck`、`npm run lint`（含边界）、6 个改动 TypeScript 文件的 Prettier 检查及 `git diff --check` 均通过。
- 最终改动格式、git diff --check、OpenSpec 严格验证及最新 macOS arm64 payload 构建/文件校验通过；进程检查未发现账号测试临时目录下的残留 Copilot 进程。追加任务 5.1 已完成，整体 8/12 项；没有重启 Desktop。


## 生成速度与缓存命中率（2026-10-23）

- SDK 1.0.25 / CLI 1.0.102 的真实 assistant.usage 返回 apiCallId、duration、outputTtftMs、outputTokens、reasoningTokens 和缓存字段。脱敏样本为 output=236、reasoning=54、duration=5557ms、outputTtftMs=3111.924417ms；累计 tokenDetails.output 同为 236，证明不能再加 54。该样本的 inputTokens=12901 已含 cache_write=12898，而累计 tokenDetails.input=3 是未缓存部分，两种接口不能套同一加法。
- 用 message.apiCallId + originatingMessageId 归属根 Turn，再关联 usage。生成 TPS=总输出/Σ(duration-outputTtftMs)，API 平均速度=总输出/Σ(duration)；只接受可靠的当前逻辑 Turn 数据。最近缓存率=cacheReadTokens/inputTokens；累计缓存交公共 Host 从完整输入事实计算。没有使用字符数估算或把工具执行时间计入生成区间。
- usage.native.test.ts 已实测输出有效生成/API 速度，刷新后不丢失；冷恢复保留累计缓存但不伪造历史速度。单元测试覆盖事件前后顺序、去重、多内部循环、迟到/子 Agent、缺失归属/计时、已知零和首字等待缺失时仅显示 API 速度。
- 公共 Host UsageMeter 与 Renderer 用量浮窗聚焦测试通过，浏览器浮窗确认约 96.5 tok/s 生成速度、42.5 tok/s API 平均速度及已知 0% 缓存率。浏览器数据为上述原生样本的公共投影，不冒充用户当前 Desktop 已载入新 Adapter。
- 本轮聚焦检查 123 通过、6 条原生开关用例默认跳过；定向原生速度/缓存/冷恢复用例通过。12 项浏览器检查通过。旧用量夹具的宽度仍按 180px 写在 button、产品周期依赖英文名称，已按现有 root min(240px,30vw)、button 100% 及显式 periodType 修正；没有修改 Renderer 生产代码。
- typecheck、lint/边界通过。需要重启 Host 加载新 Adapter；恢复旧会话后，新请求完成时才有实时速度，累计缓存可从原生历史快照恢复。未推送或发布。
- 本轮新增任务 5.2 完成，整体 9/13；改动代码格式、OpenSpec 严格验证和最新 macOS payload 构建/文件校验通过。没有重启 Desktop；已有会话恢复后需新的模型请求产生实时速度。


## 公共 Host 用量链路补充验收（2026-10-23）

- 新增 app-server-host.copilot.real.test.ts 的 public usage protocol 用例。真实隔离 Loader 加载最新 Copilot Bundle，原生 CLI 完成一次无工具模型请求后，通过浮窗实际使用的 codexhost/thread/usage/inspect 查询。
- 检查生成速度和 API 平均速度均大于零、最近与平均缓存命中率为可靠百分比、TTFT 可用，并确认私有 sessionCacheUsage 已被 Host 转换且不泄漏到公共响应。官方 Codex 对端是测试 fixture，Copilot/SDK 和模型请求为真实执行。
- CODEXHOST_COPILOT_NATIVE_TEST=1 npx vitest run --config tests/vitest.config.js packages/host-runtime/test/app-server-host.copilot.real.test.ts -t 'public usage protocol'：1 通过、2 项无关用例按名称过滤跳过。npm run build:typescript、npm run typecheck、该测试文件 ESLint 和 git diff --check 通过。
- 本轮补齐链路测试，未重复修改已存在的指标计算，也没有重启 Desktop。实际运行的 Host 仍需重新加载插件才能应用源码更新。

## 局部审查修正：诊断、检查、恢复、Windows 启动与完成事实（2026-10-23）

- 错误保留友好提示、类型、retryable 和操作阶段；只处理 message 与受限的原生错误码，不复制 SDK stderr、stack、RPC data。复用公共 sanitizeDiagnosticTail，补充 Token/引用值/URL/认证头脱敏；交互细节省略，损坏日志只保留类别和行列位置，避免回显日志正文。实际初始化、检查、执行、配置、快照、关闭和派生错误都带阶段，清理失败不覆盖原始诊断。
- inspect 按 Adapter 的固定环境和规范化 cwd 合并进行中检查。当前 availability 也是完整检查，与同 cwd 请求合并。refresh 跳过完成缓存、加入已有进行中检查；成功缓存 30 秒，失败清除 pending 且不缓存。close 停止 Client 并等待检查排空。用延迟 Promise 验证并发、不同 cwd、刷新失败重试、TTL 和关闭清理；这些是合成测试。
- SDK 1.0.25 的 resume 默认 allowTranscriptRecovery=true。CLI 1.0.102 / 协议 3 / macOS arm64 的无模型探测已验证 allowTranscriptRecovery=false 拒绝不存在 ID 和损坏日志：缺失 ID 未创建目录，损坏文件字节未变化。有效日志夹具经过两个独立 Client 的冷恢复，Session 身份和两条根消息身份保持一致，且没有 recovery 标记。夹具只写入本轮随机 UUID 目录，最终清理，不修改用户现有会话。此项是实际 CLI 解析/恢复的 fixture 验收，不是新模型对话或 Desktop 验收。
- 移除 resume 返回值被丢弃的 readPersistedEvents；保留原生占用、身份、cwd 检查和完整 readSnapshot。显式禁止转录修补，并拒绝意外的 recovery 标记。Fork 的完整分页与全文前缀保真校验未减少。
- Windows 标准 npm .cmd/.bat 只按同一前缀的 @github/copilot package 身份、bin 以及 shim 引用解析实际 JS/可执行入口；拒绝缺失、错配和越界，不运行 shell、不回退到另一安装、不下载 runtime。Windows 布局/空格路径为模拟 fixture；官方 SDK 对含空格和 & 的 JS 路径启动另在 macOS 实际执行，不能称为 Windows 实机验收。
- CopilotItems 的完成事实仅存 snapshots；has 与完成 ID 迭代使用同一个 Map，保留开始顺序 order 和活动 active。乱序完成、重复完成、取消、旧工具 Diff、原历史归属及上一轮两项 P1 永久回归保留并通过。

执行的检查：

- `npm run build:typescript`：通过（含预装插件 Bundle）。
- `npx vitest run --config tests/vitest.config.js packages/adapters/copilot/test packages/host-runtime/test/installed-harness-plugins.test.ts`：143 通过、9 跳过；19 文件通过、6 原生文件按开关跳过。跳过的用例为 8 个 Copilot 原生用例及未配置真实命令的 OpenCode 检查，其中 2 个严格恢复用例另行执行如下。
- `CODEXHOST_COPILOT_NATIVE_TEST=1 npx vitest run --config tests/vitest.config.js packages/adapters/copilot/test/resume.native.test.ts`：2 通过，5.88 秒；无模型请求。
- `npm run typecheck`：通过。
- `npm run lint`：通过，包含边界检查。
- `npx prettier --check packages/adapters/copilot/src/errors.ts packages/adapters/copilot/src/adapter.ts packages/adapters/copilot/src/session.ts packages/adapters/copilot/src/configuration.ts packages/adapters/copilot/src/command.ts packages/adapters/copilot/src/projection.ts packages/adapters/copilot/manifest.json packages/adapters/copilot/test/adapter.test.ts packages/adapters/copilot/test/errors.test.ts packages/adapters/copilot/test/command.test.ts packages/adapters/copilot/test/client.test.ts packages/adapters/copilot/test/resume.test.ts packages/adapters/copilot/test/resume.native.test.ts packages/adapters/copilot/test/projection.test.ts`：通过。
- `git diff --check`：通过。

保留账号额度、AI Credits 和共享工作区用量遥测工作；未修改 Host/Renderer 或核心进程架构，未新增审计文档体系。Windows 实机、Linux 实机、Desktop 与完整原生对话未在本轮验收；没有新建实施/委派会话，没有推送、合并或发布。
