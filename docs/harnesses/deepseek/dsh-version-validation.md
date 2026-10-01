# DSH 版本对接验证

本文记录 codexhost 支持哪些 DSH（`@deepseek-ai/dsh`）版本、每个版本的验证证据，以及尚未验证的边界。协议与显示行为见[消息修订、恢复与原生停止确认](dsh-edit-recovery.md)。

## 支持范围与版本策略

codexhost 只对接写 Session Format V4 的 DSH，最低版本为 `0.1.7-rc.1`（首个 V4 版本）。已验证版本：

| 版本 | DSH tag commit | 备注 |
| --- | --- | --- |
| `0.1.7-rc.1` | `46a7f68b0922371ce7144b668b90e377d8e799f4` | 最低支持版本 |
| `0.1.7-rc.2` | `477b4f420553e8a52c2fbccc464d7561b239c443` | |
| `0.2.0-rc.1` | `4878cdabd87d4041bdaff61d04c966883b9fd07a` | 失败的 step 开始补写工具结果 |
| `0.2.0-rc.2` | `639ed015397290b3745d163aafe02ffee4aa3f84` | 新增限时提问；安装指引固定此版本 |

- 版本门槛只拦低版本，不拦高版本。
- `dsh --version` 必须输出单行规范 SemVer。低于 `0.1.7-rc.1` 的版本（包括 `0.1.7-alpha.*` 等更早的预发布）在启动托管 Web 前返回 `unsupported`：stage 为 `version`，不可重试。中英双语提示依次说明当前版本低于最低版本、列出上表四个支持版本、说明高于 `0.2.0-rc.2` 的版本可以尝试连接但适配度可能有限，最后给出升级命令 `npm install -g @deepseek-ai/dsh@0.2.0-rc.2`。支持版本列表与升级命令由 `generation-selector.ts` 中的同一份版本列表生成。
- 不低于门槛但未验证的版本（例如以后的 `0.2.0` 正式版）按 V4 尝试。托管 Web、Remote、历史和流式数据仍逐项严格校验，不符合就明确失败。设置 → 连接只列出四个支持版本，并提示高于 `0.2.0-rc.2` 的版本可以尝试连接、但适配度可能有限。npm 上 `0.1.7-rc.2` 之后的下一个版本就是 `0.2.0-rc.1`，两者之间没有其他发布，所以提示只提“高于 `0.2.0-rc.2`”。
- 安装指引固定 `0.2.0-rc.2`，不跟随会移动的 npm `latest`。连接页的“更新 CLI”安装 npm `latest`。截至 2026-09-30，`latest` 与 `next` 均为 `0.2.0-rc.2`；`alpha` 为 `0.1.7-alpha.2`，低于门槛，会被拒绝。
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

支持范围限于同一回合：

- 只对 `wait.timed === true` 的提问生效。不显示倒计时，不调用 `attachWait`，由 DSH 按自身期限计时。
- 回答返回 `true` 时按 `responded` 关闭；返回 `false` 或业务失败（例如已有回复在排队）时按 `superseded` 关闭并返回错误；传输失败时提问保持打开。
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

`npm run test:deepseek:coverage` 先构建 TypeScript，再运行整个 DSH Adapter：**25 个文件、876 项测试全部通过**。统计范围为 `packages/adapters/deepseek-harness/src/**/*.ts`，包含未执行文件，四项门槛均为 80%：

| 指标 | 覆盖率 | 已覆盖 / 总数 |
| --- | --- | --- |
| 语句 | 87.00% | 5725 / 6580 |
| 分支 | 82.67% | 4872 / 5893 |
| 函数 | 93.31% | 907 / 972 |
| 行 | 89.79% | 5315 / 5919 |

HTML 与 JSON 摘要生成到 `coverage/deepseek-harness/`，不纳入 Git。本变更新增或改写的定向测试覆盖：

- 补写工具结果：未启动/已启动 × `forked`/`interrupted` 的正例，以及 id、错误码、`sourceEventSeqs`、内容不符的负例；实时与冷历史的 Item 身份一致，PTC `run_code` 不生成 Item。
- 限时提问：有无 `wait`、非法 `wait`、回放时 `wait` 不一致；continued、迟到回答的各种返回值、竞态中保留回答后补发、回合结束时 `expired`；`user-question-reply` 在实时与冷历史中都不投影为用户输入。
- 版本门槛：`0.1.2-rc.1`、`0.1.5-rc.3`、`0.1.7-alpha.2`、`0.1.7-rc.0` 拒绝，并逐字校验中英文提示；`0.1.7-rc.1`、`0.2.0-rc.2`、`0.2.0`、`1.0.0` 接受。
- Session Ref 与 checkpoint：无 locator、`0.1.5-rc.2` locator、`0.2.0-rc.2` locator 可恢复；`turn-end:`、`v3-turn-end:` 以及版本不一致的 checkpoint 在修改前拒绝。

V4 回放夹具 `packages/adapters/deepseek-harness/test/fixtures/dsh-020rc2-tool-call-turn.v4.jsonl`，与 `dsh-v0.2.0-rc.2` 的 `snapshots/session/tool-call-turn/session.v4.jsonl` 逐字节相同（该文件最后修改于 DSH `fb79a944f5eed29cdce0833006ac55a2478cbec4`，`snapshot.yml` 标记 `recording: live`）。DSH 快照省略事件 `seq`/`time` 并替换环境工具目录，回放测试只补回连续序号、固定时间和一个最小工具声明。

其他仓库检查：

- `npm run build:typescript`、`prettier --check .`、`cargo fmt --all --check`、包边界检查和 OpenSpec strict 校验通过；本变更改动的 41 个 TypeScript/JavaScript 文件 eslint 通过。
- `npm run typecheck` 与 `npm run lint` 只报 `tests/e2e/renderer-model-fast.spec.ts` 的既有错误（1 个 TS2379、11 个 `no-non-null-assertion`）。该文件自基线 `94e795f8` 起未改动。
- `tests/release` 在设置了 `CODEX_HOME` 的环境中失败：测试只清除 `CODEXHOST_*` 与 `NODE_PATH`，模拟的官方 app-server 因此在真实 `CODEX_HOME` 中启动并退出。去掉该变量后 14 个文件全部通过，其中 DSH 插件运行依赖断言为 `diff`、`ws`、`zod`。
- 去掉 `CODEX_HOME` 后运行全量 `vitest run --config tests/vitest.config.js`：457 个文件中 442 个通过、14 个跳过；5182 项测试中 5141 项通过、40 项跳过。唯一失败的是 WorkBuddy 的 “preserves the native failure when bridge cleanup also fails”：它依靠目录权限制造 `EACCES`，本机以 root 运行不受权限限制；该包自基线未改动。

## 未验证的边界

- 未使用真实计费模型；Desktop 端到端显示（权限选择器、PTC 子调用卡片、回合继续输出时仍打开的提问、崩溃恢复后的 Thread、`unsupported` 提示）需人工在 Desktop 中验证。
- 本次真实 CLI 验证只在 Linux 上运行，没有在 Windows 或 macOS 上复验这四个版本。
- 未用真实 CLI 触发 PTC 模式、失败的 step，以及 Fork 种子里的补写结果；Auto review 插件未启用。
- 不把默认配置下的验证推广到任意非默认 preset 或 profile；不证明独立第三方客户端或任意后台工具进程的退出。

## 历史记录

V0/V3 时期的验证记录（`0.1.2-rc.1`、`0.1.5-rc.1`/`rc.2`/`rc.3`，含 `0.1.5-rc.2` 的安装问题与当时的 CodeRabbit 复核）见本文改名前的版本：`git show 94e795f8:docs/harnesses/deepseek/dsh-015rc1-validation.md`。
