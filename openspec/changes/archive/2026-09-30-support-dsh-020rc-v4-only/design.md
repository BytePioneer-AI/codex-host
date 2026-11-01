## Context

基线为 upstream main `94e795f8`。Adapter 目前按 `--version` 选择 profile：`0.1.2` 系列 → V0，`0.1.7-rc.1` 及以上 → V4，其余 → V3；再严格校验 Web Remote、历史和流式数据。连接页已验证版本为 `0.1.2-rc.1`、`0.1.5-rc.1/2/3`、`0.1.7-rc.1/2`，安装指引固定 `0.1.5-rc.1`。

变更链路：连接页 → Host `harness/inspect` → DSH Adapter 的 `--version` 探测与托管 `dsh web` → 原生 Remote/Session → Adapter 历史及实时投影 → 公共 Harness 输出 → Host 投影到 Desktop。原生 Session、迁移和凭据归 DSH；Host 只持有映射与标准输出。版本与格式差异只留在 Adapter 内。

审计的 DSH tag：`dsh-v0.1.7-rc.2`（`477b4f420553e8a52c2fbccc464d7561b239c443`）、`dsh-v0.2.0-rc.1`（`4878cdabd87d4041bdaff61d04c966883b9fd07a`）、`dsh-v0.2.0-rc.2`（`639ed015397290b3745d163aafe02ffee4aa3f84`）。两个 0.2.0 tag 的 `session-format-catalog` 均为 `currentVersion: 4`，最新迁移包为 `session-format-v3-to-v4`。

PR #412（omsd512，未合并）的 5 个提交以 cherry-pick 纳入本分支，保留原作者信息；整理提交时合并为本 PR 的前 2 个提交。

## Goals / Non-Goals

**Goals:** 验证并交付 `0.2.0-rc.1`、`0.2.0-rc.2`；限时提问在同一回合内可迟到回答；纳入 #412；把支持范围收敛到 V4（最低 `0.1.7-rc.1`）并删除 V0/V3 代码；已有 Thread 在用户升级 DSH 后仍可恢复；代码、规格、测试、文档和连接页提示一致。

**Non-Goals:** 跨回合的迟到回答，以及恢复 Session 时重建仍待回答的提问；在 Desktop 显示倒计时或调用 `attachWait` 认领等待；Desktop profile（`dsh plugin --profile desktop`）；DSH 产品统计与遥测；在 codexhost 内复制 DSH 的格式迁移；自动升级用户 CLI；改动 Host、其他 Harness 或公共契约。

## Decisions

1. **最低版本为 `0.1.7-rc.1`。** 仍只接受单行规范 SemVer。低于门槛的版本在启动 Web 前返回 `unsupported`（stage `version`，不可重试）；中英文提示列出已验证版本，说明高于最新已验证版本的版本可以尝试连接但适配度可能有限，并给出升级命令。只拦低版本，不拦高版本：不低于门槛的未验证版本沿用“尝试托管 Web + 原生协议严格校验”，不获得已验证声明。
   备选一：门槛设为 `0.2.0-rc.1`。这会让已验证且仍写 V4 的 `0.1.7` 用户无故失效，不采用。备选二：改回精确版本白名单。这与现行“探测 + 校验”策略冲突，而且每个补丁版都要发版，不采用。

2. **合并为单一 V4 profile。** V4 目前是在 V3 profile 上叠加的增量：`v017.ts` 展开 `DEEPSEEK_V015_PROFILE`，并复用其 Assistant stream、frame、baseline、chunk/content、team/feedback 校验。做法是把这些被复用的部分与 `v017.ts` 合并为 `profiles/v4.ts`，删除 `v012.ts`、`v015.ts`、`v017.ts`。`profile.ts` 只保留接口、SemVer 比较与门槛；`sessionFormatVersion`、`assistantStream`、`checkpointPrefix` 等改为常量或删除；所有默认 profile 参数改为 V4，modern adapter 不再默认 `0.1.2-rc.1`。
   备选：保留 `v015.ts` 作为“基础层”。名称会误导，还会留下 V3 专用的死分支，不采用。

3. **引用兼容与现行行为等价。** 恢复 Session 时，引用没有 locator（V0 时期）或 locator 中的 `dshVersion` 为任意合法 SemVer（V3/V4 时期）都可以尝试打开，由 DSH 原生迁移和 V4 严格校验决定成败。Fork/回滚 checkpoint 仍须带 `v4-turn-end:` 前缀，且 locator 与当前 CLI 版本完全一致；`turn-end:`、`v3-turn-end:` 在 mutation 前拒绝。codexhost 只写过这两类 locator，所以简化后对现有数据的判定不变。

4. **接受 DSH 恢复产生的合成工具结果，历史与实时一致投影。** DSH 会在三处给没有结果的工具调用补写 `tool/result`：崩溃恢复和 Fork 种子（0.1.7 起由 `openTurnClosers` 生成），以及失败的 step（`0.2.0-rc.1` 起由 `ToolCallRecovery` 生成）。两者共用下列结果形状：
   - 未启动的调用：错误为 `ToolNotStartedError`/`TOOL_NOT_STARTED`，没有 `sourceEventSeqs`，内容为一个文本块；id 为 `forked-tool-result-<callId>-<seq>`（seq 等于该事件自身序号）或 `interrupted-tool-result-<callId>-<整数>`（与 DSH 自身迁移代码的判定一致，不要求等于事件序号）；
   - 已启动的调用：错误为 `ToolOutcomeUnknownError`/`TOOL_OUTCOME_UNKNOWN`，`sourceEventSeqs` 指向其 `tool/call`，现有匹配逻辑已能接受。

   V4 校验把目前只认 `forked` 的判断扩展到上述精确形状，其余仍报 unmatched，并保留负例测试。实时投影记录 Assistant 宣告的工具调用：未启动调用的合成结果与冷历史一样投影为失败的工具项（Item 身份相同）；若该调用是 PTC 的 `run_code`，与 #412 的规则一致不生成 Item。不伪造成功。

5. **限时提问支持同一回合内的迟到回答（B 级）。** DSH `0.2.0-rc.2` 的 timed 提问分两次结算：前台 waterfall 到期由 DSH 取消并让工具返回 pending，之后的回答经 `userQuestions/answer` 作为用户消息注入 Agent。
   - `user-questions/request` 允许可选的 `wait: { callId, timed? }`：`callId` 须为非空字符串，`timed` 须为布尔值，其他未知键仍拒绝。codexhost 不调用 `attachWait`、不设 `expiresAt`，所以 DSH 按自身期限计时，Desktop 不显示倒计时。
   - 对 `timed: true` 的提问，若 DSH 取消前台等待时同一 Host 回合仍在进行，Desktop 上的提问保持打开。之后以日志中该 callId 的原生结果为准：`tool/result`（PTC 时为 `tool/ptc-dispatch`）为 pending 载荷或 `TOOL_OUTCOME_UNKNOWN` 时，提问转为 continued；为回答、跳过、取消或其他失败时关闭提问。
   - continued 提问的回答调用 `userQuestions/answer`，参数为 `{ agentId: sessionId, callId, answer }`。返回 `true` 时按 `responded` 关闭；返回 `false` 或业务失败（例如已有回复在排队）时按 `superseded` 关闭并返回错误；传输失败时保持打开。跳过只在本地关闭，不写原生回复，与 DSH“关闭面板不产生回复”的语义一致。
   - 竞态：DSH 对已结束事件的 `$events/result` 静默返回成功。所以回答在前台等待结束前后提交时，Adapter 先不回复 Host，等该 callId 的原生结果：是 pending 则用 `userQuestions/answer` 送达，由回执决定关闭方式；及时回答已被收下则按 `responded` 关闭；释放后才提交、而调用已在别处回答，则按 `superseded` 关闭并返回错误；调用失败（例如回合取消）时模型没有收到回答，即使是及时回答也按 `cancelled` 关闭并返回错误。`ask_user_question` 是独占调用，DSH 在回答或到期后立即写入结果，所以等待很短。
     最初的实现先回复成功，再在后台补发；补发失败时回答会被静默丢弃（PR #456 的 CodeRabbit 意见），因此改为等待结果。
   - Host 回合结束前，仍打开的 continued 提问以 `expired` 关闭。Host 在回合完成后不再接受该回合的输出，所以不支持跨回合回答；恢复 Session 时也不重建 continued 提问。
   - 迟到回答以 `user/message`（来源 `user-question-reply`）写入日志，Adapter 不把它投影为用户输入。
   备选一：只接受请求结构、到期即关闭（A 级）。模型继续工作后 Desktop 上的提问随之消失，用户无法回答，不采用。备选二：跨回合回答（C 级）。需要改 Host 的回合与交互生命周期，超出本变更范围。备选三：调用 `attachWait` 并显示倒计时。Desktop 的 `autoResolutionMs` 只显示时长、不会自动结束；持有 claim 还会让 DSH 停止计时，提问变成阻塞式，不采用。

6. **先对接、后删除，分阶段提交。** 阶段 1 在现有三格式代码上完成 0.2.0 修复与真实 Gate；阶段 2 删除 V0/V3；阶段 3 更新界面与文档。每个阶段独立可验证、可回退，出问题时能区分“新版本差异”和“删除回归”。

7. **已验证版本与推荐安装版本以 Gate 为准。** Gate 全部通过后，已验证版本为 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`，安装指引固定 `0.2.0-rc.2`（与 npm `latest` 一致）。若某个 0.2.0 版本未通过，则不列入；此时安装指引固定为已通过的最新版本，并在验证记录中写明原因。验证记录改名为 `docs/harnesses/deepseek/dsh-version-validation.md`，内容随本变更更新。

8. **纳入 PR #412，阶段 2 删除其 V0/V3 分支。** #412 为 V4 修复两处问题：PTC 子调用各自投影为 Host Tool Item 并隐藏 `run_code`；权限模式改为读取进程级 `permissionPresets/catalog`。0.2.0 的 PTC dispatch 与权限预设源码与 0.1.7-rc.2 相同，#412 同样适用。阶段 2 删除它为 V0/V3 保留的分支（`projectsPtcDispatches` 的格式判断、`settings/describe` 路径）。
   CodeRabbit 在 #412 上建议拒绝 V4 catalog `options` 中的 `auto`，不采纳：DSH `catalog()` 只在自动审批集成存活时把 `auto` 列入 `options`，此时 `/permission auto` 可被接受；拒绝它会让这类部署的检查整体失败。

## Risks / Trade-offs

- **旧版本用户被拒绝连接** → 提示中列出支持版本并给出升级命令；连接页“更新 CLI”可升级到 npm `latest`；旧 Session 由 DSH 在打开时迁移。
- **测试迁移量大，覆盖率可能跌破 80%** → 先把依赖默认 V0 的测试改写为 V4，再删除 V0/V3 专用用例；以 `npm run test:deepseek:coverage` 的四项 80% 门槛把关。
- **放宽合成 `tool/result` 可能掩盖真正的不匹配** → 只接受第 4 条的精确形状，保留 id、错误码、`sourceEventSeqs` 的负例测试。
- **Desktop 对“回合继续输出时仍打开的提问”的显示未经验证** → Pi 切片已知 Desktop 的 `serverRequest/resolved` 不会收起外部 Thread 的提问控件；本变更只改 Adapter，Desktop 表现由用户手测确认并在 PR 中列出。
- **迟到回答依赖 DSH 的 pending 结果与 `userQuestions/answer`** → 只对 `timed: true` 的请求启用；回合结束前统一关闭；DSH 拒绝时关闭且不伪造回答。
- **真实 Gate 难以稳定制造 step 失败或 timed 提问** → 若模型桩无法触发，就以 0.2.0 源码中的事件形状做定向测试，并在验证记录中注明“未经真实 CLI 覆盖”。
- **平台覆盖有限** → 以往 Gate 在 Windows 上运行，本机为 Linux；验证记录按实际执行的平台、Node、npm、Vitest 版本填写，不推断其他平台。
- **发布前窗口期** → npm `latest` 已是 `0.2.0-rc.2`，本变更发布前，用户点“更新 CLI”就会升到未验证版本，应优先完成阶段 1。

## Migration Plan

发布后，低于 `0.1.7-rc.1` 的用户在连接诊断中看到 `unsupported`、支持的版本和升级命令。升级后 DSH 在打开旧 Session 时自行迁移到 V4，codexhost 按第 3 条恢复已映射的 Thread；迁移前的 checkpoint 不再用于 Fork/回滚。回退 codexhost 到本变更之前的版本不会产生数据风险，旧 Adapter 同样能读取 V4。本变更不自动升级 CLI，也不改写原生 Session 数据。

## Open Questions

无。最低版本、迟到回答范围、验证记录改名和纳入 #412 均已在决策 1、5、7、8 中确定。

## 协议差异与当前证据

`0.1.7-rc.2` → `0.2.0-rc.1` 共 261 个提交，`0.2.0-rc.1` → `rc.2` 共 187 个提交，绝大多数是 Web/Desktop UI、文档和各包版本号。按 codexhost 实际使用的对接点逐项核对如下：

| 对接点 | 0.1.7-rc.2 → 0.2.0-rc.1 | 0.2.0-rc.1 → rc.2 | codexhost 需要的改动 |
| --- | --- | --- | --- |
| npm 包 `@deepseek-ai/dsh`、bin `dsh`、`--version` 输出 | 不变 | 不变（CLI 只新增 `dsh plugin --profile desktop`） | 无 |
| `dsh web --no-open --host --port`、`dsh web: <url>` 就绪行、token、`dsh-auth-*` cookie、401 指纹 | 不变 | 不变 | 无 |
| Unary RPC：`session/*`、`settings/describe`、`commands/execute`、`permissionPresets/catalog` | 服务端不变；浏览器端 `fork()` 新增 `onCreated` 回调 | 不变 | 无 |
| `$events`、`/api/remote.mux` | remotes 新挂载 product-analytics（仅 desktop profile 启用） | 新挂载 `userQuestions` Remote（`answer`、`attachWait`）；gateway 新增内部 `hasLiveClient()` | 调用 `userQuestions/answer`（决策 5） |
| `HEAD /api/session.export` flush | 不变 | 不变 | 无 |
| Session Format | V4，持久化变更记录没有新增 | V4；新增同版本变更 `2026-09-21-user-question-reply`（消息来源 `user-question-reply`） | 无：V4 校验只要求来源非空且不是 `plugin`。补回归测试 |
| 合成 `tool/result` | step 失败时也写恢复结果（`interrupted-tool-result-*`）；崩溃恢复自 0.1.7 起已写 | 不变 | **需要**：见决策 4 |
| `user-questions/request` | 不变 | 可选限时模式，请求多带 `wait: { callId, timed? }`；自带 preset 默认仍是阻塞模式 | **需要**：见决策 5 |
| PTC dispatch、权限预设 catalog | 不变 | 不变 | 纳入 #412（决策 8） |
| 其他：遥测、schedule 移至 experimental、web-search、文件上传、session-log 上传开关热切换 | 不涉及 codexhost 使用的 wire | — | 无 |

两个 0.2.0 版本均已发布到 npm，dist-tags 为 `latest`/`next` = `0.2.0-rc.2`。以上结论全部来自源码审计，需由阶段 1 的真实 Gate 确认。

codexhost 侧删除 V0/V3 的范围（行数为纳入 #412 前的值）：

| 位置 | 处理 |
| --- | --- |
| `profiles/v012.ts`（211） | 删除 |
| `profiles/v015.ts`（772）+ `profiles/v017.ts`（232） | 合并为 `profiles/v4.ts`，删除 V3 专用部分 |
| `profiles/profile.ts`（110） | 只保留接口、SemVer 比较与最低版本 |
| `generation-selector.ts` | 增加最低版本门槛与 `unsupported` |
| `modern/history.ts`（41 处）、`journal.ts`（16）、`modern/deepseek-harness-adapter.ts`（9）、`permission-modes.ts`（8）、`session-list.ts`（7）、`control-store.ts`（4）、`session.ts`（3）、`commands.ts`（3）、`configuration.ts`（2）、顶层 `deepseek-harness-adapter.ts`（2），以及 #412 的 `ptc-dispatch.ts` 格式判断 | 删除非 V4 分支；默认 profile 改为 V4 |
| 测试：`modern/v015.test.ts`、`profiles/parser-boundaries.test.ts`、`generation-selector.test.ts`、V3 夹具 `dsh-015rc1-empty-response-retry.v3.jsonl` | 删除 V0/V3 专用用例；共享的流式用例迁入 V4 测试 |
| 测试：`modern/history.test.ts`、`modern/journal.test.ts`（全部基于默认 V0）、`session.test.ts`、modern adapter 测试等 | 改写为 V4 数据 |
