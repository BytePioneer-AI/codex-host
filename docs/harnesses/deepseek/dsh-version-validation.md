# DSH 版本对接验证

本文记录 codexhost 支持哪些 DSH（`@deepseek-ai/dsh`）版本、每个版本的验证证据，以及尚未验证的边界。协议与显示行为见[消息修订、恢复与原生停止确认](dsh-edit-recovery.md)。

## DeepSeek Desktop 连接

默认仍启动托管的 `dsh web`，包括 `dsh` 来自桌面安装包的情况。显式选择 `desktop` 后连接已经运行的 DeepSeek Desktop Host（`http://127.0.0.1:19387/`），使用 Desktop 原生的插件、权限、模型配置、登录状态和 Session Store。桌面应用须先启动；连接失败会明确报错，不回退到 Web profile。

`CODEXHOST_DEEPSEEK_HARNESS_CONNECTION_MODE` 可设置为 `web`（默认）、`desktop` 或 `auto`。主动选择 `auto` 时，Adapter 解析 `dsh` 的真实路径：macOS 上指向桌面安装包 `*.app/Contents/Resources/runtime/cli/bin/dsh`、Windows 上指向 NSIS 安装目录 `resources\runtime\cli\bin\dsh.cmd` 就连接 Desktop；普通 npm/npx CLI 继续使用托管 Web。显式 `desktop` 会在未配置命令时探测官方安装位置的包内 CLI，即使它不在 PATH 中：macOS 为 `/Applications` 与用户 `~/Applications` 下的 `DeepSeek Harness.app`，Windows 为 `%LOCALAPPDATA%\Programs\DeepSeek Harness`（NSIS 固定按用户安装且禁止改目录）；其他安装位置可在连接页设置路径。DeepSeek Harness 官方仅发行 macOS（DMG）与 Windows（EXE）桌面版，Linux 无官方桌面安装，`desktop` 模式需通过 PATH 中的 CLI 或连接页设置路径。`CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT` 在 Desktop 模式覆盖本机端点，仍只允许无凭据、无查询参数的 loopback 根地址。命令覆盖仍由 `CODEXHOST_DEEPSEEK_HARNESS_COMMAND` 提供。

本地连接页的 DeepSeek 详情提供 `auto`、`desktop`、`web` 连接模式，默认显示 `web`，选择后按 Host 数据目录自动保存，重启 codexhost 生效；当前运行中的会话保持原连接。已保存的连接模式优先于上述模式环境变量，未保存时沿用环境变量或默认 Web。此设置经插件公开构造上下文传入 Adapter，Host 不参与原生连接策略。

Desktop 连接使用 DSH `client-connection` 的原生签名 Cookie 协议：只读 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）中的 `client-connection/browser-session` grant，校验文件权限、文档版本与 32 字节签名密钥。每次 HTTP 请求或 WebSocket 握手签发绑定目标 authority 的一小时 Cookie；不提取或使用模型 API Key，不改写 credential store，也不使用 Desktop 的一次性启动 token。自定义 credential provider/path 不在当前自动认证范围内。Cookie 和签名密钥仅保留在 Adapter 内存，不进入 Renderer、Session Ref 或诊断。

DSH 的 BrowserAuth 在 Desktop Connection 激活时加载或创建该 grant，独立于账号登录。连接握手成功只证明本地 Host 接受 Cookie；Adapter 的 `inspect()` 还会读取模型和权限目录，真实发消息则由选中模型的 Provider 执行。账号未登录时的具体错误取决于该 Provider 的原生返回，不能由握手成功推断发送一定成功。

Desktop 项目分组使用原生 `workspace/create({ request: { path: cwd } })` 按真实目录解析已有 Workspace，或在不存在时创建。保留已有标题，不按项目显示名匹配。新 Session 通过 `session/create` 的 `workspaceId` 参数关联分组，不能同时传 `cwd`；会话 journal 使用原生返回的规范路径。恢复旧的未分组会话时，先验证其原生 journal，再检查 Workspace 成员；缺少关联时用原生 `session/create` 的既有身份 adopt 语义补关联，不传新的 agent preset，不替换历史。已经属于分组的会话跳过 adopt，保留顺序。Fork 延续原生 Workspace 继承规则。

原生依据为本机 DeepSeek Desktop `0.2.0-rc.2`（build commit `5e9e301d`）的 `dsh-desktop-host`、`dsh-client-connection` 与 `dsh-credentials-local`。CLI 不允许直接启动 `desktop` profile；连接现有 Desktop Host 保留这个所有权限制。Adapter 关闭时只关闭自己的流，不停止桌面应用或它的 Host。Desktop 的“打开 Web UI”启动 token 不对外发布，故此连接不提供 Web UI handoff。

本机已验证 Desktop 认证、模型目录、`$events` 原生流与已加载插件的 Host `inspect()`；重启后 Codex Renderer 状态为 installed。2026-10-05 通过 Adapter 选用 Desktop 的 `local / DeepSeek V4 Flash` 发送真实消息，原生 Turn 以 `completed` 结束，持久化的 assistant 消息为 `OK`，来源为 `provider: local`、`model: sensenova/deepseek-v4-flash`。另一次对 Desktop 官方模型的真实请求以 `TRANSPORT` 失败，原生重试 5 次后显示 `DeepSeek Messages transport failed`；此错误不能归因为未登录。Desktop GUI 中的完整发送流程仍未验证。聚焦测试覆盖默认 Web、CLI symlink 自动识别、显式模式、标准安装包 CLI 发现、端点约束、签名与续期、非法 grant、文件权限、原生 RPC、认证拒绝以及不启动/终止 Desktop 进程。其他 Desktop 版本尚未验证；Windows 桌面安装的标准位置识别有单元测试覆盖但未在实机验证，Linux 无官方桌面发行。

## 自动压缩链路

自动压缩的阈值、工具结果修剪、摘要、上下文替换和溢出重试由 DSH 原生 `compaction-basic` 所有，Host 不发送额外 `/compact`，也不调用 Codex 的远程压缩接口。

Adapter 将同一原生 Turn 的 `compaction/start` / `compaction/end` 按 `compactionId` 投影为稳定 ID 的 `contextCompaction` Item；成功、原生错误和 Turn 提前终止均收敛 Item。压缩错误只结束该 Item，不强制结束原生 Turn。原生日志只有错误文本、没有独立取消标签时，不通过文本猜测取消。历史读取和恢复沿用相同 ID 与结果；手动命令仍使用命令结果链路，带 `sourceCommandId` 或 `turn: null` 的事件不重复生成自动压缩 Item。`compaction/prune` 不伪装成一次摘要压缩。

上下文占用订阅原生 `contextPressure`，优先使用 `projectedTokens`（包含原生 surface 替换影响），旧投影退回 `pressureTokens`；缺失或无有效窗口时保留原有 usage 回退。占用变化不扣减累计消费计数，控制投影更新不重新扫描完整日志。

DSH 可以在 pre-step、持久化带 requestId 的用户消息之前压缩。已确认接收的 prompt 在该原生压缩期间暂停等待关联的超时，结束后重新计时；Host 仍等待真实 requestId 关联才发布该 Turn 的缓冲事件，不猜测原生 Turn 身份，也不放宽请求结果不确定时的恢复规则。

定向回归覆盖 V4 自动压缩、重复压缩、错误后 Turn 继续、历史恢复、取消收敛、手动命令去重、仅修剪的占用更新及 pre-step 关联超时。此链路的协议依据为 DSH upstream `639ed015` 的 `compaction-basic/src/index.ts`、`region.ts` 与 `token-meter/src/usage-projection.ts`；模拟协议测试不等于真实模型或 Desktop 验证。

## 支持范围与版本策略

codexhost 只对接写 Session Format V4 的 DSH，最低版本为 `0.1.7-rc.1`（首个 V4 版本）。已验证版本：

| 版本 | DSH tag commit | 备注 |
| --- | --- | --- |
| `0.1.7-rc.1` | `46a7f68b0922371ce7144b668b90e377d8e799f4` | 最低支持版本 |
| `0.1.7-rc.2` | `477b4f420553e8a52c2fbccc464d7561b239c443` | |
| `0.2.0-rc.1` | `4878cdabd87d4041bdaff61d04c966883b9fd07a` | 失败的 step 开始补写工具结果 |
| `0.2.0-rc.2` | `639ed015397290b3745d163aafe02ffee4aa3f84` | 新增限时提问 |

- 版本门槛只拦低版本，不拦高版本。
- `dsh --version` 必须输出单行规范 SemVer。低于 `0.1.7-rc.1` 的版本（包括 `0.1.7-alpha.*` 等更早的预发布）在启动托管 Web 前返回 `unsupported`：stage 为 `version`，不可重试。中英双语提示依次说明当前版本低于最低版本、列出上表四个支持版本、说明高于 `0.2.0-rc.2` 的版本可以尝试连接但适配度可能有限，最后给出升级命令 `npm install -g @deepseek-ai/dsh@0.2.0-rc.2`。支持版本列表与升级命令由 `generation-selector.ts` 中的同一份版本列表生成。
- 不低于门槛但未验证的版本（例如以后的 `0.2.0` 正式版）按 V4 尝试。托管 Web、Remote、历史和流式数据仍逐项严格校验，不符合就明确失败。设置 → 连接只列出四个支持版本，并提示高于 `0.2.0-rc.2` 的版本可以尝试连接、但适配度可能有限。npm 上 `0.1.7-rc.2` 之后的下一个版本就是 `0.2.0-rc.1`，两者之间没有其他发布，所以提示只提“高于 `0.2.0-rc.2`”。
- 首次安装、安装指引及连接页的“更新 CLI”均跟随 npm `latest`；保留既有安装管理策略，不因本次协议合并重新固定版本。安装最新版不代表已验证兼容，连接仍须通过 V4 协议校验。截至 2026-09-30，`latest` 与 `next` 均为 `0.2.0-rc.2`；`alpha` 为 `0.1.7-alpha.2`，低于门槛，会被拒绝。
- 旧 Session Ref 没有 locator（V0 时期）或带任意合法 SemVer locator（V3/V4 时期）时，都可以尝试恢复。Fork checkpoint 必须带 `v4-turn-end:` 前缀，且 locator 与当前 CLI 版本一致。

## 0.2.0 源码审计

审计按固定 tag 进行：`dsh-v0.1.7-rc.2` → `dsh-v0.2.0-rc.1`（261 个提交）→ `dsh-v0.2.0-rc.2`（187 个提交），只核对 codexhost 实际使用的对接点。两个 0.2.0 tag 的 `packages/session/session-format-catalog/src/generated.ts` 均为 `currentVersion: 4`，最新迁移包仍是 `session-format-v3-to-v4`。

| 对接点 | 0.1.7-rc.2 → 0.2.0-rc.1 | 0.2.0-rc.1 → 0.2.0-rc.2 | codexhost 处理 |
| --- | --- | --- | --- |
| npm 包、`dsh` 命令、`--version`、`dsh web` 启动参数、就绪行与认证 | 不变 | 不变（CLI 只新增 `dsh plugin --profile desktop`） | 无 |
| Session Format | V4，没有新增持久化变更记录 | V4；新增同版本变更 `2026-09-21-user-question-reply`，`user/message` 与 `agent/inbox/spliced` 中的消息可带 `user-question-reply` 来源 | 不投影为用户输入；补历史与实时回归测试 |
| 补写的 `tool/result` | 失败的 step 也由 `ToolCallRecovery`（`packages/core/session/src/repair.ts`）补写；崩溃恢复与 Fork 种子自 0.1.7 起已有 | 不变 | 历史与实时都接受精确形状 |
| `user-questions/request` | 不变 | 可选限时模式（`packages/interaction/tool-ask-user/src/timed.ts`）：请求带 `wait: { callId, timed? }`；新增 `userQuestions` Remote（`answer`、`attachWait`）；gateway 新增内部 `hasLiveClient()` | 接受 `wait`；支持同一回合内的迟到回答 |
| PTC dispatch（`packages/core/tools/src/ptc.ts`）、权限预设（`packages/interaction/permission-presets`） | 不变 | 不变 | 纳入 #412 |
| Unary RPC、`$events`、`HEAD /api/session.export` flush、Fork 与队列命令 | codexhost 使用的部分不变 | 不变 | 无 |

rc.1 没有限时提问，`wait` 与迟到回答只出现在 rc.2。逐项差异与决策见归档的 [design](../../../openspec/changes/archive/2026-09-30-support-dsh-020rc-v4-only/design.md)。

## 真实 CLI 验证

环境：Linux x86_64（内核 5.10.134-19.8.al8）、Node.js `v22.23.2`、npm `10.9.8`、Vitest `4.1.10`。四个版本分别用 `npm install --prefix <临时目录>/<版本> @deepseek-ai/dsh@<版本>` 隔离安装。`dsh --version` 与目标版本一致，所有 `@deepseek-ai/dsh-*` 子包也是同一版本（依次为 267、273、278、278 个）。

全部验证都用本地 SSE 模型桩和隔离的临时 `DSH_HOME`，不调用真实计费模型。下文的探测脚本是一次性脚本，没有纳入仓库；它们直接调用最终代码构建出的 Adapter，步骤按下文描述可以复现。

### 生命周期 Gate

```bash
CODEXHOST_DSH_REAL_COMMAND=<临时目录>/<版本>/node_modules/.bin/dsh \
  npx vitest run --config tests/vitest.config.js tools/gate-dsh/lifecycle.real.test.mjs
```

| 版本 | 结果 | Vitest 耗时 |
| --- | --- | --- |
| `0.2.0-rc.2` | 1/1 通过 | 5.89 秒 |
| `0.2.0-rc.1` | 1/1 通过 | 6.04 秒 |
| `0.1.7-rc.2` | 1/1 通过 | 6.43 秒 |
| `0.1.7-rc.1` | 首次失败（见下）；随后 3 次复跑均 1/1 通过 | 6.02 / 6.00 / 5.97 秒 |

Gate 覆盖托管 Web 启动、inspect/create、流式增量、取消及 HTTP 流停止、空/保留历史回滚、冷恢复、继续输入、默认配置保持、源历史不变、活动关闭和请求无重叠。它不覆盖原生 Fork、工具调用恢复和限时提问，这些由下面的探测验证。

`0.1.7-rc.1` 首次运行在“请求无重叠”断言上失败：模型桩收到 `FIRST_INPUT` 请求时，另一个响应尚未结束。原因是模型桩的判定方式：用户消息中含 `FIRST_INPUT`、`HOLD_INPUT` 或 `THIRD_INPUT` 就算主请求。DSH 并发发出的会话标题请求会把首条输入嵌进提示词（“Generate the session title from this JSON array of human messages: …”），与主请求时间重叠时就被误判。失败记录中同一 Session 有两条单消息的 `FIRST_INPUT` 请求，与这一解释一致；标题生成代码在 `0.1.7-rc.1` 与 `rc.2` 之间没有变化。因此判定为模型桩的时序问题，不是 CLI 或 Adapter 缺陷。本变更没有修改 Gate。

### 权限与 Fork

四个版本各运行一次，结果相同：

- 检测得到 `read-only`、`workspace-write`、`danger-full-access` 三个模式，默认 `workspace-write`，并公布可切换能力。
- 以 `read-only` 新建会话，在会话内切换到 `workspace-write`，状态和快照均确认新值。
- 跑两个回合后，在第一个回合的 checkpoint（`v4-turn-end:26`，locator 为当前版本）Fork。子会话只继承第一个输入，权限为 `workspace-write`，能继续新回合；源会话历史不变。
- locator 版本不一致的 checkpoint 返回 `invalidRequest`，`v3-turn-end:` 前缀返回 `checkpointNotFound`；两次拒绝后源会话都没有变化。
- 换新的 Adapter 冷恢复源会话和子会话，历史与权限均保持；把 Session Ref 的 locator 改为 `0.1.5-rc.2` 后仍可恢复。
- 无人值守委派新建成功，原生模式为 `danger-full-access`。

### 旧会话迁移

先用本机全局安装的 `0.1.5-rc.2`（231 个 `@deepseek-ai/dsh-*` 子包均为 rc.2）以 headless profile 回答一次任务，写出 `session.v3.jsonl.zstd`。然后用最终的 Adapter 和 `0.2.0-rc.2`，以 `0.1.5-rc.2` locator 恢复：

- DSH 打开时把会话迁移到 V4。历史为 1 个回合（`v4-turn-end:17`），返回的 Ref locator 更新为 `0.2.0-rc.2`。
- 继续新回合成功。
- 迁移前的 `v3-turn-end:1` checkpoint 在修改前以 `invalidRequest` 拒绝；在迁移后的 V4 checkpoint Fork 成功。

回滚最后一个回合失败（`protocolError`），且没有创建新会话。原因不在迁移：回滚要先读取源会话的 agent preset，用来重建或校验替换会话，而 headless profile 写出的 Session header 没有 `agentPreset`。用 `0.2.0-rc.2` headless 直接生成的 V4 会话同样失败。这一 fail-closed 检查自 `7ba0868c` 起就存在，本变更没有改动。codexhost 通过托管 Web 创建的会话带有 `agentPreset`（例如 `standard`），不受影响。

### 工具调用恢复

模型桩在第一步并行请求 `bash`（`sleep 30`）和 `read`。第一个 Tool Item 开始约 0.8 秒后，用 SIGKILL 结束托管的 `dsh web` 进程，再用新的 Adapter 恢复。四个版本结果相同：

- DSH 补写 `interrupted-tool-result-toolu_sleep-21` 和 `interrupted-tool-result-toolu_read-22`。前者为 `ToolOutcomeUnknownError`/`TOOL_OUTCOME_UNKNOWN`，`sourceEventSeqs` 指向其 `tool/call`；后者为 `ToolNotStartedError`/`TOOL_NOT_STARTED`。
- 恢复成功。该回合以 `nativeFailure`（“DeepSeek Harness Turn ended with 'interrupted'”）结束，两个 Tool Item 均为 failed。
- 修复前的 Adapter（`1d0fc521`，即 upstream main 加 #412）在 `0.1.7-rc.2` 与 `0.2.0-rc.2` 上恢复失败：`protocolError`，“Modern history contains an unmatched tool/result”。

进程被杀后，原 Session 报告 `session.faulted`，关闭时可能报告无法确认原生停止，这些都是预期结果。失败的 step（`0.2.0-rc.1` 起）和 Fork 种子里的补写结果没有用真实 CLI 触发；它们与崩溃恢复共用同一套结果形状，由按 0.2.0 源码形状编写的定向测试覆盖。

### 限时提问与迟到回答

限时提问只有 `0.2.0-rc.2` 支持，且 DSH 自带 preset 默认仍是阻塞模式。探测在隔离 `DSH_HOME` 的 `profiles/web/cordis.patch.yml` 中覆盖 `preset-standard`，把 `tool-ask-user` 设为 `mode: timed`、`timeout: 3`（秒）。模型桩第一步调用 `ask_user_question`（一个问题，选项 A/B），第二步调用 `bash`，第三步回复。

| 场景 | 第二步 `bash` | 结果 |
| --- | --- | --- |
| 迟到回答 | `sleep 4` | 1.5 秒出现提问；约 4.5 秒 DSH 到期，工具返回 pending，提问保持打开。5.1 秒提交回答，Adapter 调用 `userQuestions/answer` 被接受；第三步的模型请求收到 `[{"id":"pick","selected":["B"]}]`。回合于 8.6 秒成功，提问以 `responded` 关闭，没有产生自主回合 |
| 到期不答 | `sleep 1` | 回合约 5.6 秒结束，提问以 `expired` 关闭 |
| 及时回答 | `sleep 4` | 1.5 秒回答，工具正常返回，提问以 `responded` 关闭 |

“及时回答”的最终回复文本是 “No answer”，因为模型桩只统计 `answer_to_pending_question` 形式的迟到回复，与 Adapter 无关。修复前的 Adapter（`1d0fc521`）在迟到回答场景中直接故障：`protocolError`，“DeepSeek Harness sent an invalid user question request”（拒绝 `wait` 字段）。

改为“原生结果出来后再回复”（见下文）之后，用同一探测复测了三种场景，关闭原因和模型收到的回复都与上表一致。及时回答现在要等该调用的 `tool/result` 写入才返回，实测多等 13 毫秒；迟到回答从提交到返回用了 9 毫秒。

支持范围限于同一回合：

- 只对 `wait.timed === true` 的提问生效。不显示倒计时，不调用 `attachWait`，由 DSH 按自身期限计时。
- 回答返回 `true` 时按 `responded` 关闭；返回 `false` 或业务失败（例如已有回复在排队）时按 `superseded` 关闭并返回错误；传输失败时提问保持打开。
- 原生结果未知时提交的回答先不返回。DSH 刚释放等待时会出现这种回答；及时回答恰好撞上到期时也会，因为 DSH 会静默丢弃这条回复。Adapter 等该调用的 `tool/result`（PTC 子调用为 `tool/ptc-dispatch`）后再处理：
  - 记录为 pending：改用 `userQuestions/answer` 送达，结果按上一条处理。
  - 记录为回答：及时回答说明 DSH 已收下，按 `responded` 关闭；释放后才提交的回答说明调用已在别处回答，按 `superseded` 关闭并返回错误。
  - 记录为失败（例如回合取消使提问以 `ASK_ABORTED` 结束）：模型没有收到回答，按 `cancelled` 关闭并返回错误。及时回答也是如此。
  - Session 故障或关闭时不再等待。
- 这段等待很短：`ask_user_question` 是独占调用，DSH 在回答或到期后立即写入结果。它也必须短，因为 Host 逐条处理 Desktop 输入，并等待回复结果。
- 跳过只在本地关闭，不写原生回复，与 DSH“关闭面板不产生回复”的语义一致。
- Host 回合结束前仍未回答的 continued 提问以 `expired` 关闭。不支持跨回合回答，恢复 Session 时也不重建 continued 提问。
- 迟到回答以 `user/message`（来源 `user-question-reply`）写入日志，不投影为用户输入。
- `0.2.0-rc.1` 及更早版本没有限时模式，提问行为不变。

### 过旧版本

用本机全局安装的 `0.1.5-rc.2` 检测：71 毫秒内返回 `unsupported`（stage `version`，不可重试）。提示列出四个支持版本、高于 `0.2.0-rc.2` 的版本可以尝试连接但适配度可能有限的说明，以及中英文升级命令。新建会话同样被拒绝。隔离的 `DSH_HOME` 仍为空，说明托管 Web 没有启动。

## #412：PTC 子调用显示与 V4 权限模式

本变更纳入 PR #412 的改动（原 5 个提交整理为本 PR 的前 2 个提交，作者不变），并删除它为 V0/V3 保留的分支。0.2.0 的 PTC dispatch 与权限预设源码和 0.1.7-rc.2 相同，所以两项修复同样适用于 0.2.0。

**PTC 子调用。** 显示规则见[消息修订、恢复与原生停止确认](dsh-edit-recovery.md)。事件语义依据 DSH `packages/core/tools/src/ptc.ts`：

- 开始事件在子调用真正开始时写入。
- 每个已开始的子调用恰好对应一条结束事件，取消也不例外。
- 两条事件都位于外层 `run_code` 的 `tool/result` 之前。

#412 的验证记录：在 Windows 上离线回放 9 个真实原生会话（V0/V3/V4 × standard/ptc），V4 ptc 会话中的 `pwsh`/`read`/`grep`/`glob` 子调用均显示为命令卡片，不再出现 `run_code` 卡片。本次没有用真实 CLI 触发 PTC 模式，Desktop 实时显示待手测。

**V4 权限模式。** DSH 0.1.7 起，`settings/describe` 的 `defaultPreset` 只剩普通字符串。可选模式改由进程级 `permissionPresets/catalog` 返回（`options`、`defaultOptions`、`defaultPreset`），会话 `permissions` 投影只有 `currentValue`。Adapter 的处理：

- 从该目录读取模式列表。DSH 对未组合的服务返回 `gateway/service-unavailable` 时隐藏选择器；其他错误仍使检测失败。
- 当前值为 `custom` 时照常显示，但从不作为可选项。
- `auto` 由实验性 Auto review 插件在运行中登记。出现在 catalog `options` 中时可选，但不能作为配置的默认值。插件晚于目录读取登记时，当前值为 `auto` 仍照常显示；重新检测会重新读取目录。

CodeRabbit 在 #412 上建议拒绝 catalog `options` 中的 `auto`，本变更不采纳。DSH `catalog()` 只在自动审批集成存活时把 `auto` 列入 `options`，此时 `/permission auto` 可被接受；拒绝它会让这类部署的检测整体失败。

#412 当时在 Windows、Node.js `v24.11.0`、DSH `0.1.7-rc.1` 上做过真实 CLI 验证：检测、带模式新建、会话内切换、冷恢复、无人值守委派，生命周期 Gate 1/1 通过（7.38 秒）。本次在 Linux 上对四个版本复验，见上文“权限与 Fork”。Auto review 插件未在本机启用，`auto` 只由单元测试覆盖。

## 移除 V0/V3

- 删除 V0（`0.1.2` 系列）与 V3（低于 `0.1.7-rc.1` 的其他版本）的 profile，把 V3/V4 两个 profile 合并为 `profiles/v4.ts`。同时删除 `modern/*` 与顶层 Adapter 中的格式分支、`settings/describe` 权限路径，以及 #412 的 `projectsPtcDispatches` 格式判断。所有默认 profile 改为 V4。
- 插件不再依赖 `@deepseek-ai/schemastery`（及其依赖 `@deepseek-ai/cosmokit`）；它只用于 V0/V3 的 `settings/describe` 权限解析。插件运行依赖只剩 `diff`、`ws` 和 `zod`。
- 删除 V0/V3 专用测试与 V3 夹具，共享用例改写为 V4 数据。
- 用户影响：`0.1.2`/`0.1.5` 用户必须先升级。升级后 DSH 在打开旧会话时迁移到 V4，已映射的 Thread 可以恢复（见上文“旧会话迁移”）。迁移前的 checkpoint 不能再用于 Fork；回滚最后一个回合始终从当前历史重新计算，不受影响。
- codexhost 不迁移、不改写原生 Session 文件，也不保证新日志可以由旧版 DSH 打开。

## 自动化测试与覆盖率

`npm run test:deepseek:coverage` 先构建 TypeScript，再运行整个 DSH Adapter。下面的结果在第 11 个提交 `3ca7509b`（本 PR 的最终代码）上运行：**25 个文件、882 项测试全部通过**。它取代归档任务 2.6 在删除 V0/V3 时记录的 876 项及当时的覆盖率；之后的提交又补了测试。统计范围为 `packages/adapters/deepseek-harness/src/**/*.ts`，包含未执行文件，四项门槛均为 80%：

| 指标 | 覆盖率 | 已覆盖 / 总数 |
| --- | --- | --- |
| 语句 | 87.07% | 5738 / 6590 |
| 分支 | 82.73% | 4882 / 5901 |
| 函数 | 93.42% | 909 / 973 |
| 行 | 89.81% | 5326 / 5930 |

HTML 与 JSON 摘要生成到 `coverage/deepseek-harness/`，不纳入 Git。本变更新增或改写的定向测试覆盖：

- 补写工具结果：未启动/已启动 × `forked`/`interrupted` 的正例，以及 id、错误码、`sourceEventSeqs`、内容不符的负例；实时与冷历史的 Item 身份一致，PTC `run_code` 不生成 Item。
- 限时提问：有无 `wait`、非法 `wait`、回放时 `wait` 不一致；continued、迟到回答的各种返回值；原生结果未知时先等结果再回复，覆盖补发被拒、传输失败后重试、及时回答遇到失败结果、故障与关闭；回合结束时 `expired`；`user-question-reply` 在实时与冷历史中都不投影为用户输入。
- 版本门槛：`0.1.2-rc.1`、`0.1.5-rc.3`、`0.1.7-alpha.2`、`0.1.7-rc.0` 拒绝，并逐字校验中英文提示；`0.1.7-rc.1`、`0.2.0-rc.2`、`0.2.0`、`1.0.0` 接受。
- Session Ref 与 checkpoint：无 locator、`0.1.5-rc.2` locator、`0.2.0-rc.2` locator 可恢复；`turn-end:`、`v3-turn-end:` 以及版本不一致的 checkpoint 在修改前拒绝。

V4 回放夹具 `packages/adapters/deepseek-harness/test/fixtures/dsh-020rc2-tool-call-turn.v4.jsonl`，与 `dsh-v0.2.0-rc.2` 的 `snapshots/session/tool-call-turn/session.v4.jsonl` 逐字节相同（该文件最后修改于 DSH `fb79a944f5eed29cdce0833006ac55a2478cbec4`，`snapshot.yml` 标记 `recording: live`）。DSH 快照省略事件 `seq`/`time` 并替换环境工具目录，回放测试只补回连续序号、固定时间和一个最小工具声明。

其他仓库检查，同样在 `3ca7509b` 上运行：

- 完整的 `npm run format:check`（Prettier 与 `cargo fmt`）、`npm run lint`（ESLint 与包边界检查）、`npm run typecheck` 和 `git diff --check` 均通过。
- 本变更改动的四份 OpenSpec 主规格 strict 校验通过。`openspec validate --all --strict` 有 23 项失败，与 `f813ba7b` 上的结果完全相同。
- 基于旧基线 `94e795f8` 时，`npm run typecheck` 与 `npm run lint` 只报 `tests/e2e/renderer-model-fast.spec.ts` 的既有错误（1 个 TS2379、11 个 `no-non-null-assertion`），当时只能确认本变更改动的文件 eslint 通过。upstream 已在 `7c520d24` 修复该文件；本 PR 改为基于 `f813ba7b` 后，这两条命令完整通过。
- `tests/release` 在设置了 `CODEX_HOME` 的环境中失败：测试只清除 `CODEXHOST_*` 与 `NODE_PATH`，模拟的官方 app-server 因此在真实 `CODEX_HOME` 中启动并退出。去掉该变量后 14 个文件全部通过，其中 DSH 插件运行依赖断言为 `diff`、`ws`、`zod`。
- 去掉 `CODEX_HOME` 后运行全量 `npm run test:typescript`（含 TypeScript 构建）：463 个文件中 447 个通过、14 个跳过、2 个失败；5243 项测试中 5201 项通过、40 项跳过、2 项失败。两项失败所在的包本变更没有改动，与 upstream main 相同：
  - WorkBuddy 的 “preserves the native failure when bridge cleanup also fails” 依靠目录权限制造 `EACCES`，本机以 root 运行不受权限限制。
  - Cursor CLI 的 “uses current WAL activity rather than only the checkpointed database timestamp”（随 upstream main 新增）在本机稳定失败，候选列表为空，原因未查。
- Host Runtime 的 “gives later plugins a full timeout after earlier plugins finish” 偶发超时：之前一次全量运行失败，单独运行和本次全量运行都通过。

## 未验证的边界

- 未使用真实计费模型；Desktop 端到端显示（权限选择器、PTC 子调用卡片、回合继续输出时仍打开的提问、崩溃恢复后的 Thread、`unsupported` 提示）需人工在 Desktop 中验证。
- 本次真实 CLI 验证只在 Linux 上运行，没有在 Windows 或 macOS 上复验这四个版本。
- 未用真实 CLI 触发 PTC 模式、失败的 step，以及 Fork 种子里的补写结果；Auto review 插件未启用。
- 不把默认配置下的验证推广到任意非默认 preset 或 profile；不证明独立第三方客户端或任意后台工具进程的退出。

## 历史记录

V0/V3 时期的验证记录（`0.1.2-rc.1`、`0.1.5-rc.1`/`rc.2`/`rc.3`，含 `0.1.5-rc.2` 的安装问题与当时的 CodeRabbit 复核）见本文改名前的版本：`git show 94e795f8:docs/harnesses/deepseek/dsh-015rc1-validation.md`。
