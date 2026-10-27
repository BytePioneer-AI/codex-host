# Tasks

## 1. 路由与 Desktop 接入

- [x] 1.1 收窄外部创建路由到对应草稿或显式创建操作，修复官方定时任务被 Host 残留选择覆盖的问题，保留普通聊天偏好及预热行为。验证：扩展 `renderer-draft-prewarm-policy.test.ts` 及相关 Renderer 路由测试，覆盖先选 Pi 后官方创建、两个入口交错、草稿预热消费和已有外部 Thread 归属不变；更新相关路由文档。
- [x] 1.2 在 `desktop-control` 增加聚焦的本地任务/默认工作区接入，必要的浏览器安全契约放入 `shared-contracts`；确认 Desktop heartbeat 所需聊天注册、模式及就绪状态，不暴露通用执行桥。验证：为当前支持版本的服务形状、缺失/歧义、非本地 Host、默认根目录及工作区失败添加受控 fixture；按实际跨包依赖执行构建与边界检查，并将内部接口限制记录在功能文档中。

## 2. 创建流程与自有页面

- [x] 2.1 组合现有 Host 外部 Thread 创建和 Desktop heartbeat 保存，显式携带 Harness/Model，目录留空使用官方分配结果；创建阶段不执行任务正文，实现必要的重复提交防护、明确失败重试和结果不确定提示。验证：聚焦集成测试覆盖配置实际进入 Thread、日程仅绑定该 Thread、无立即执行、日程保存失败复用 Thread、超时不自动重放和不删除工作区。
- [x] 2.2 在 Desktop 内现有设置页注册“定时任务”创建页，复用插件/模型目录，提供每日/每周本地时间及高级设置中的可选目录；成功后打开目标聊天并指引官方管理。验证：按现有 Playwright 配置覆盖 Harness/Model 切换、空目录/指定目录、不可用状态、页面卸载、双击提交，以及窄屏/深浅色显示；确认未改变普通聊天偏好，未向独立 Console 注入无接入能力的页面。同步创建或维护 `docs/product/harness-schedules.md`，在 `docs/index.md` 登记并写明首版范围。
- [x] 2.3 将现有 heartbeat 管理扩展为同时接纳本地官方 Codex 与外部 Harness，复用同一列表/修改/暂停恢复/删除路径，写前确认真实归属并保留绑定和未修改字段，不新增存储或通用 CRUD 框架。验证：在现有回归基础上覆盖 Codex 与外部任务共同展示及管理、其他类型排除、归属查询失败不冒充 Codex、修改保留字段与 RRULE、未知写入不重放、删除不操作聊天/文件/当前 Turn；同步功能文档。受控 API 测试已覆盖这些边界。
- [x] 2.4 将同一设置页列表扩展为同时显示 Codex 与外部 Harness 的标签和管理入口，复用现有表单及聊天打开能力，保持新建仅外部 Harness。验证：增加混合列表、Codex 历史聊天入口、修改/暂停恢复/确认删除的浏览器回归，确认不发起外部创建；保留已有生命周期和重复操作测试，更新中文深浅色截图与文档。Playwright fixture 和中文混合列表截图已完成；真实 Desktop 双列表互通仍留在 3.2。

## 3. 固定聊天调度验收

- [ ] 3.1 用 Pi 和一个环境中可用的其他 Harness 做真实 Desktop 最小验收：创建固定聊天任务、离开创建页后接收实际到期消息、重启后恢复调度、连续运行复用同一 Thread 和目录、聊天修改 Model 后沿用有效配置。验证：核对真实目标 Harness/Model、Thread ID、目录、触发消息及完成状态；不能用仅点击“立即运行”代替到期验证。需要启动源码版时使用根目录 `npm start`；记录版本、未覆盖组合及阻塞原因，保持未通过项未勾选；测试结束清理测试日程，不删除用户文件。
- [ ] 3.2 验收官方窗口仍创建 Codex Thread，两处列表可读取和管理相同的 Codex 与外部固定聊天日程且不改变归属，修改不新建聊天、删除保留历史；验证原生忙碌/审批行为未被旁路。按最终 diff 选择仓库要求的最小类型、Renderer 构建和聚焦测试，更新功能文档中的已验证边界，并运行本 change 的 OpenSpec strict 校验；不扩展为全 Harness 认证或全量测试矩阵。

任务 2.2 的勾选仅表示原创建页已完成。2.3/2.4 的完成表示统一列表与管理已由受控 API/页面 fixture 覆盖；不代表真实 Desktop 双列表互通验收通过。

## 实施验证记录（2026-10-27）

- 1.1：请求桥不再覆盖无来源的创建；草稿 setter 按原生 client Thread 身份绑定，不持久化官方默认 Model；原生预热消费按本次配置检查，任务创建跳过普通草稿预热。覆盖交错、并发、跨 Host 恢复、预热清理及既有 Thread 归属路径。
- 1.2：仅绑定 Desktop 26.1021.31345 已核对的模块导出。fixture 覆盖缺失/歧义、非本地/退役 manager、primary window 服务、配置根目录和工作区失败。真实 Desktop 仅做只读检查：模块导出、registry/manager 身份、原生 ThreadCreation 的 params-only 形状及 fs/readDirectory 返回形状；没有以这些检查替代实际调度验收。
- 2.1：空输入原生建聊、Host 配置确认、原生模式/权限/eligibility 确认、同 Thread 保存失败重试、双提交去重、写入结果未知/超时不重放、页面取消后不继续保存、保存确认但列表刷新失败不重放，均有聚焦测试。
- 2.2：浏览器测试覆盖 Harness/Model 切换、空/指定目录、不可用、卸载、双提交、未知结果、Console 不注册和普通偏好保持。390/1100 宽度的深浅色截图已检查；窄屏使用设置外壳的原生纵向滚动。
- 3.1 未执行：本次源码未安装到正在用于主会话审查的 Desktop，且验收包含重启恢复。遵守不自行停止/重启当前 Desktop 的约束，未执行 `npm start`，没有热替换其运行时，也没有创建测试日程。Pi、第二个 Harness、到期消息、离页/连续执行、Model 修改和重启恢复全部保留未验收；没有需要清理的新日程，既有用户任务未修改。
- 3.2 部分完成：本地类型、构建、边界、聚焦测试和 OpenSpec strict 校验通过；真实官方创建窗口、官方列表管理外部任务、原生忙碌/审批尚未验收，因此整项不勾选。macOS 以外平台未做真实 Desktop 验收。

执行成功的检查：

- `npm run build:typescript`
- `npm run typecheck`
- `npm run lint`（包含 `tools/check-boundaries.mjs`；实施前基线与最终检查均执行）
- `npm run build:renderer`
- `npx vitest run --config tests/vitest.config.js packages/desktop-control/test/desktop-harness-schedules.test.ts packages/desktop-control/test/renderer-scoped-creation.test.ts packages/desktop-control/test/renderer-draft-prewarm-policy.test.ts packages/desktop-control/test/renderer-prewarm-cleanup.test.ts packages/desktop-control/test/renderer-host-routing.test.ts packages/renderer-extension/test/versioned-renderer-adapter.test.ts`：6 文件、110 项通过。
- `npm run test:e2e -- tests/e2e/renderer-adapter-lifecycle.spec.ts tests/e2e/renderer-harness-schedules.spec.ts`：12 项通过。
- 对全部改动 TypeScript 文件执行仓库安装的 Prettier `--check`；`git diff --check`。
- `openspec validate add-desktop-backed-harness-schedules --strict --no-interactive`。

未运行全量测试、Rust 检查或 Harness live Gate；本次没有 Rust、Adapter 或依赖修改。没有提交、推送或归档；proposal、design 和两份 spec 保留为用户输入。

## 第一轮审查修正（P1）

- 移除 `knownRejection` 对任意 numeric `jsonRpcCode` 的豁免。写入阶段只有现有 `DesktopScheduleRejectedError` 可表示经具体接口确认的写前拒绝；其他异常返回 `unknown/retryable:false`，后续提交返回已记录结果，不再次写入。
- 新增 6 个回归组合：`save`、`createThread`、`allocate` 分别抛带 `-32603`、`-32000` 的错误；检查第二次提交不增加任何写调用，且不进入未执行的后续阶段。强化已知写前保存拒绝的用例：两次保存使用相同 Thread，分配目录和创建 Thread 均只调用一次。
- 修复前仅运行新增组合，6 项均失败并返回 `failed/retryable:true`；修复后运行整个 `desktop-harness-schedules.test.ts`，25 项通过。本轮另执行这两个 TypeScript 文件的 ESLint、Prettier 检查及 `git diff --check`，均通过。没有重跑其他单测、E2E、全量构建或检查。
- 证据边界：上一轮真实 Desktop 只读看到 Composer Fiber 缓存中的 scope/atom 形状及 scope.value 的 `clientThreadId` 字段，没有恢复并 live 验证精确的 draft→setter 关联。ThreadCreation 实例的自身键只有 `params`、构造器源码未检出私有字段是只读观察；14 槽 setter 关联、params 内部结构与调用顺序、collaborationMode 引用传递、每次调用视图和预热隔离行为来自 bundle 分析与 fixture。
- 普通草稿真实发送的 native Model carrier、预热隔离和本功能真实调度均未 live 验证。4/6 仅表示实现与 fixture 任务完成，不代表功能验收通过；3.1/3.2 保持未勾选。本轮未操作 Desktop 或用户日程，未提交、推送或归档。

## 列表与管理实施记录（2.3 / 2.4）

- 复用 native `localAutomations.list/update/delete` 和 `codexhost/thread/ownership/list`。仅展示并管理已确认本地外部 heartbeat；写前重读当前值、检查唯一 automation id、目标 Thread 和持久化 ownership。局部失败提示未确认数量，不将整体读取失败显示为空列表。
- 更新原 id，保留目标 Thread、当前未修改字段、通知策略和 RRULE。复杂周期不开放基础时间编辑，仍可修改名称/正文。暂停/恢复只更新状态；删除前明确确认，仅调用 native 日程删除，不调用聊天/目录删除或 Turn 取消。
- 管理写入异常全部按未知结果处理，不以 numeric RPC error 判为安全重试。写入未结算、旧读取或归属未确认的刷新不能解除重放防护；只有新的确认读取后用户才能发起后续操作。没有自动重放、日程镜像、持久化工作流或后台轮询。
- 同页列表、新建与修改复用原表单正文/日程控件及现有页面作用域。重新进入、显式刷新、操作成功均重读；历史通过已有聊天入口打开，独立 Console 不注册此页。
- 与本轮开始快照比较，生产 TypeScript **新增 1051 行、删除 271 行，净增 780 行**（包含类型与 UI，已有表单移动已抵扣；不含测试和文档）。新业务模块为 `desktop-harness-schedule-management.ts`；原表单提取到 `harness-schedule-form.ts` 供创建和编辑共用。

本轮执行并通过：

- `npm run build:typescript`、`npm run typecheck`、`npm run lint`（包含边界检查）、`npm run build:renderer`。
- `npx vitest run --config tests/vitest.config.js packages/desktop-control/test/desktop-harness-schedule-management.test.ts packages/desktop-control/test/desktop-harness-schedules.test.ts`：**50 项通过**，其中本轮新增 21 项管理/周期测试、4 项 native 绑定测试；原创建流程和 P1 回归仍通过。
- `npm run test:e2e -- tests/e2e/renderer-harness-schedules.spec.ts`：**17 项通过**，其中 **10 项为本轮新增**的管理、生命周期及中文截图覆盖，不使用旧 12 项结果代替新增验证。
- 本轮改动 TypeScript 的 Prettier 检查、后补测试文件的聚焦 ESLint、`git diff --check`。
- `openspec validate add-desktop-backed-harness-schedules --strict --no-interactive`。

中文截图（受控浏览器 fixture，已查看；不是实际 Desktop 用户任务）：
- `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-review-vp3j5_6c/schedules-zh-light-1100.png`
- `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-review-vp3j5_6c/schedules-zh-dark-1100.png`
- `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-review-vp3j5_6c/schedule-edit-zh-light.png`
- `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-review-vp3j5_6c/schedule-edit-zh-dark.png`
- `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-review-vp3j5_6c/schedules-zh-light-390.png`
- `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-review-vp3j5_6c/schedules-zh-dark-390.png`

数据源一致性已通过调用链和共用 native store 的受控 API/页面 fixture 检查；没有在真实 Desktop 同时操作官方列表与自有列表验证互通。本轮只读检查安装包里的 native update/delete 实现，没有执行真实管理写操作、停止或热替换 Desktop。真实到期、重启恢复、普通草稿 carrier/预热隔离和双界面管理验收仍归 3.1/3.2，均保持未勾选。当前 **6/8** 仅表示实现及 fixture 任务完成，不代表功能验收通过。没有提交、推送或归档。

## 基本周期兼容修正（P2）

- 核对安装包 `src-Dl21kCYQ.js` 中 `vl` 的 DAILY/WEEKLY 路径：无 BYSECOND 时使用 0 秒。基础解析允许省略秒数，支持单日每周；全七天必须每个 weekday 有效且只出现一次，再识别为每日。显式非 0 秒、重复/非法 weekday、部分多日、DTSTART/TZID/COUNT/UNTIL、多时刻及非 1 间隔仍不转换。
- 页面无时间修改时继续省略 schedule patch、保留原 RRULE；真实官方形状 `RRULE:FREQ=WEEKLY;BYHOUR=10;BYMINUTE=15;BYDAY=SU,MO,TU,WE,TH,FR,SA` 已加入受控 parser 和页面回归。仅使用该规则文本，不操作用户 Pi 任务。
- “打开聊天”失败回调在当前页面有效时同时取消 status.hidden；失败 opener 测试确认提示可见，没有重构消息系统。
- 修复前新增的 4 个官方形状 parser 用例全部失败；修复后 `packages/shared-contracts/test/harness-schedules.test.ts` 的 21 项全部通过。
- 本轮仅执行受影响检查：shared-contracts 包的 `tsc -b`；上述 parser 单测；management 文件中基本周期、保留字段及改时间的 3 项聚焦测试；页面中官方每日形状、仅改正文、复杂规则保留、打开聊天失败共 4 项 E2E；4 个改动 TypeScript 文件的 ESLint/Prettier 与 `git diff --check`，均通过。没有重跑无关全套。
- 页面布局不变；官方全七天规则现在显示每日 10:15 并开放时间控件。新增下列中文浅/深色 fixture 截图，已查看；此前列表/编辑截图保留不覆盖。
  - `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-p2-review-44g9nmtg/official-daily-edit-zh-light.png`
  - `/Users/chongwen.zhang/work/study/codex-host/.codexhost/harness-schedules-p2-review-44g9nmtg/official-daily-edit-zh-dark.png`

## 官方 Codex 纳入统一列表（2.3 / 2.4 增量）

- 同一 `localAutomations.list/update/delete` 管理路径现将经 Host ownership 确认的本地 Codex heartbeat 映射为 Codex 标签，同时显示并管理外部 Harness heartbeat。ownership 读取失败、目标 Thread 不匹配或外部归属携带 Codex 标识时，该行进入未确认计数，不显示为 Codex，也不开放写入。
- 编辑、暂停/恢复、确认删除均在写前重读 automation 与 ownership，并保留原 automation id、targetThreadId、Model 所属的 Thread 配置及未修改的 RRULE/通知策略。删除仍只调用日程删除。Codex 管理测试未调用外部 Thread 创建；新建表单只接受显式外部 Harness，创建路径未变。
- 本增量执行：`npx vitest run --config tests/vitest.config.js packages/desktop-control/test/desktop-harness-schedule-management.test.ts`（22 项通过）；`npm run test:e2e -- tests/e2e/renderer-harness-schedules.spec.ts`（21 项通过，包含 Codex 管理和混合列表截图）；`npm run typecheck`、`npm run build:renderer`、相关 TypeScript 文件 ESLint/Prettier 及 `git diff --check`。OpenSpec strict 校验在增量结束时运行。
- 新中文混合列表 fixture 截图（已检查）：`.codexhost/harness-schedules-codex-mixed-zh/schedules-zh-light-1100.png`、`.codexhost/harness-schedules-codex-mixed-zh/schedules-zh-dark-1100.png`。真实 3.1/3.2 仍未验收；没有重启 Desktop 或读写真实用户日程。

真实 3.1/3.2 继续未勾选。本轮没有重启、停止或热替换 Desktop，没有真实日程写操作，没有提交、推送或归档。
