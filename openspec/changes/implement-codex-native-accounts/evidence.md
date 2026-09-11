# 实施证据与支持边界

## 固定范围

- 实现分支：`feat/codex-native-account-switching`；基线 `9d22515ec63d5ff79eec4a12d6d56b721b2bd361`。
- 工作目录：原 checkout 旁的独立 `codex-host-native-accounts` worktree。
- opencodex：`2d4d7a22381a2e497c2442902104619e25f937c7`，MIT 资产与来源 notice 已加入两种发行布局。
- 完整设计：[设计说明](../../../docs/codex-native-account-switching-design.md)；产品说明：[账号设置](../../../docs/codex-accounts.md)。
- PR 前测试只用临时目录、合成凭据、假密钥和假认证网络。用户随后授权提交、推送、普通审查 PR #262，并允许起停 Desktop 诊断。后续实际启动与隔离结果单独记录如下；未完成真实账号认证／切换、系统密钥生命周期或推理验收，未发布。

## 已执行验证

下表是 PR 创建前的验证基线；后续启动／原生登录协议修正单独记录，不能用旧基线替代新改动的验证。它不是全仓测试套件，也不是真实产品认证证明。

| 验证 | PR 前执行结果 |
| --- | --- |
| `npm run build:typescript` | 通过，包含插件产物重建 |
| `npm run typecheck` | 通过，生产与完整 test project |
| `npm run lint` | 通过，包含 Workspace boundary check |
| 新增／修改的 Vitest 文件＋run-host-runtime | 39 文件，571 通过，3 个 Windows-only skip；包含完整 AppServerHost、布局、release notices 和实际 compiled private helper |
| Host shutdown／UI 最后一轮回归 | 4 文件，195 通过；亦包含于上述最终集合 |
| Renderer build 与三份聚焦 Playwright | 43 通过；模拟 Desktop 页面，不是实际 Desktop |
| Rust platform／launcher tests | platform 56、launcher unit 48、launcher CLI 4 通过 |
| Rust scoped clippy `-D warnings`、fmt | 通过 |
| `npm run format:check`、OpenSpec strict validation、`git diff --check` | 通过 |
| 私有文件 session 并发重复验证 | 20/20 次通过；每次运行两项 session 测试 |
| 修正测试 fork 干扰后的锁／platform 重复验证 | pi 子任务：锁测试 50/50、并行 platform suite 100/100 通过；主任务随后重跑 platform＋launcher 通过 |
| Windows／Linux platform test compilation | 子任务执行通过；未运行平台测试 |
| Windows launcher 交叉构建 | 尝试后受外部 `llvm-rc` 缺失阻断 |

详细原始日志留在实施机器的 `/tmp/codexhost-native-accounts-tasks/`，不提交日志或 reference 仓库。最终测试列表为 `final-test-manifest.txt`，主要结果为 `final-focused-tests.log`、`renderer-e2e-final.log`、`rust-validation-final.log`；其余检查各有 `*-final.log`。可复跑入口以根 `package.json` 和 `tests/vitest.config.js`／`tests/e2e/playwright.config.js` 为准。compiled-helper 测试通过 `CODEXHOST_TEST_NATIVE_LAUNCHER="$PWD/target/debug/codexhost"` 显式启用，只操作合成临时目录；三个跳过项分别为两项 Windows 进程监督/receipt 和一项 Windows npm CLI 测试。

两项完整 AppServerHost 测试曾因旧插件产物失败；执行 `npm run build:typescript`（含 `build:plugins`）后通过。最终 shutdown 复跑还发现旧 fake 把 EOF 当实际退出却仍断言必须 SIGTERM，且模拟 signal 不产生退出事件。现分别显式覆盖正常 EOF 和忽略 EOF 后的 SIGTERM 退出，未删掉停止断言；另补回归修复初始化 cleanup 退出不明时误使外部 Harness 不可用，以及 eager close 的未处理 rejection。

一次并行 Rust session 测试未取得预期 ready；其临时路径原来只有时钟值，现加原子序号隔离并提高错误断言精度，完整及 20 次重复验证通过。另一个锁释放测试的并行失败经 pi 定位为其他测试 fork 时临时继承锁描述符：隔离单测 50/50，通过并行原测试第 8 次复现，独立 fork probe 验证继承关系。只把断言隔离到无其他 fork 的测试进程，不改变生产锁语义、不加重试或 sleep；随后 100 次并行 platform suite 通过。红灯证据保留在 `rust-validation-final.red.log` 等文件，不把失败误记为通过。

最后只读安全检查使用用户指定的 pi `openai-codex/gpt-5.6-sol`。确认并修复了首次登录激活前过早清 stage 导致的虚假 ready 和恢复意图丢失；两个回归经过实际 Manager 流程触发。初报的“登录 RPC 无限等待”已撤回：真实 `OfficialRequestBroker` 有 30 秒超时，原 never-settling fake 不能证明生产死锁。未为这个误判添加重复超时或新协调层。

## 已落地的关键回归

- 管理连接先于 Desktop；managed Scope 不能绕过账号初始化失败。
- Vault 提交后 lost ACK／Journal 清理失败不回滚；首次安装先恢复再导入。
- 当前 A 的最后 Token、失败目标轮换、同账号新授权、完全相同凭据字节的安装事实均保留。
- 当前重登恢复后不重放旧 staging grant；添加 B 后恢复 A 失败仍保全 A2 和已保存 B。
- 首次激活完成前保留 staging 意图；失败保持 unavailable，重启或 recover 可激活已保存的首次账号。
- 私有 I/O 使用同一持锁进程，不因正常并发 poison；路径替换及非空 macOS ACL 拒绝。
- 真实 Store/helper 组合创建 login 父目录，避免内存 fixture 的递归 mkdir 掩盖生产失败。
- 不把 backend.closed 当退出证明；recover 可重试证明，不先清工作标记。
- 最新原生 settings 覆盖初始参数；A→B→A 中间无 lazy resume 时仍保留 settings；临时 Thread 阻止切换。
- Scope 关闭后迟到 Owner.start 被拒绝，重复 close 不跳过失败的树退出；spawn 前重新检查写入后的租约。
- 非当前额度刷新使用准入和最新 Vault 合并；cache CAS 只应用本账号补丁。
- 旧布局失败明确阻断、源目录不删除；目录逐项读取并使用跨 home 的数量／字节预算，不先读入无界目录数组。
- v2 与 Renderer 不再提交旧 Account 选择字段；仅保留两处明确拒绝旧输入的 guard。
- 登录完成按 loginId 对账，不要求 provisional Account ID 不变；旧邮箱和已先到达的 ready 快照都不能虚构成功，无邮箱保存账号仍可查额度。

## PR 前同步 main

提交前同步到 `44f9289779940e1e1a138753a2fac9d1d146c774`，保留 main 的 Cursor／Antigravity 改动。同名新增的设计文档采用已获授权、包含实际实施与验收状态的版本。

同步后重新执行 TypeScript build、严格 typecheck、lint/boundaries、Renderer build、全仓格式检查，均通过；聚焦测试扩展到 53 文件，731 通过、3 个 Windows-only 跳过，三份 Renderer E2E 43 通过。记录见 `pr-merge-*.log`。

首次同步测试与 E2E 同时运行时，一项合成 private-file 队列测试在 helper 启动的 2 秒期限内超时；该项独立复查及完整聚焦集合复跑均通过。没有修改超时或队列断言，也没有把这次失败隐藏为全部一次通过；其时序稳定性仍需在 CI 观察。

## PR #262 启动与原生协议后续

用户报告 Desktop initialize 返回 `-32087 / Codex is unavailable` 后，加入真正发送 initialize 的组合测试取得相同 RED。修复将活 Host 的 transport 初始化与 native readiness 分开，保留客户端 attachment／协商；startup cleanup 不再 terminal-close 可恢复 Scope，也不停止其他客户端所属的 staging。

实际起停 Desktop 时又发现两层启动配置问题：LaunchServices 未显式接收 home/profile 覆盖；只设置 Electron userData 环境也不足以改变 Chromium 的早期 session 存储。前两次尝试未实现完整隔离，已停止，不计入隔离验收，也不宣称它们从未接触默认 profile。加入绝对目录 allowlist 和匹配的 `--user-data-dir` 后，新 profile 确实创建，检查到的三个 profile 文件句柄均在临时根内。真实 Desktop `26.903.71938` 进入登录界面；该次两份自身日志未发现 fatal initialize 签名，停止后没有该临时根的存活文件句柄。未主动读取真实认证文件、打开授权网页或完成真实登录。

读取已安装 Desktop 的代码和官方 `0.153.4` 完整 schema 还确认了原生协议缺口：Desktop 使用 `type:chatgpt` OAuth，完成依赖 `account/login/completed`／`account/updated`，取消响应应为 `status:canceled/notFound`。现保留原生 OAuth／设备代码输入、启动响应先于完成的顺序与 onboarding 字段；原生登录激活身份的 durable intent 与 Settings 仅添加分开，但共用一个 staging 和事务。正式后台的新 generation 才从实际 account/read 投递身份更新；慢客户端、退休响应和观察者失败不改凭据事实。

本轮目前已执行：

- Launcher 路径回归先 RED，再通过目录转发和 Chromium 参数测试及实际 macOS profile 检查。
- 新原生登录协议、管理器及 AppServerHost／Scope 组合：6 文件，188 通过、1 个未启用 helper 的跳过；严格 typecheck 通过。与此前集合有重叠，不累加计数。
- 真实官方 CLI＋compiled helper 的 opt-in 集成：受保护 listener 冷启动、保留同一 Desktop client、OAuth 开始后立即取消、回到未登录正式后台，通过。未打开或输出 OAuth URL；正式凭据始终为空，staging 清理，OAuth callback 端口释放，最多一个受控官方后台。Vault 使用假密钥，不触及真实 OS keyring；私有随机 home 的测试仅保留受控 writer reconciliation，不冒充生产的全机进程 inventory 验证。
- 真实 CLI 揭示 idle 新 Thread 可先返回计划路径却尚无 rollout。原生 resume 的明确拒绝现映射为 busy，保留该内存 Thread 与后台；相关实际 CLI＋单元组合 28 通过。初次把这种未落盘 Thread 当作持久 Thread 的恢复测试前提已纠正，未据此伪造持久历史或修改 goal API。
- 另取得“操作已准入但 stage 尚未建立时取消丢失”的 RED；开始 barrier 现从准入建立，取消和 close 在检查／注册阶段都有效。覆盖首次状态广播中的同步取消，不额外创建登录协调器。
- 调用生产 `host.disconnect()` 的合成回归曾在恢复后等待已退出的旧 Turn。现在 Owner 在每次真实 stop proof 完成后通知仍附着的客户端，清理本客户端工作记账；failed stop、EOF 和 client detach 不触发该通知。回归先确认 native busy 已消失但 Host 仍不结束，再证明修复有效。初始探针误用了无效 fixture 选项，后续 gate-phase 观察也不能代替退出事件，两者都未作为成功修复保留。

最后修正后的 build/plugins、严格 typecheck、lint/boundaries 通过；完整聚焦集合 **56 文件、759 通过、3 个 Windows-only skip**，包括显式启用的真实官方 CLI 和 compiled helper。Renderer build 与三份 E2E **43 通过**；相关 Rust **platform 56、launcher unit 52、CLI 4**，scoped clippy 与 fmt 通过。最后格式和 OpenSpec 对账另有检查日志。未运行全仓测试或跨平台 Desktop。

最后代码另对真实官方 CLI 的隔离生命周期执行 **10/10** 次重复验证，记录为 `native-retirement-live-repeat-*.log`；结束后 OAuth callback 端口无 listener。每次仍是不打开授权 URL、不完成认证的开始／取消流程，不累加为十项新的功能覆盖。

完整复跑中另一次未改动的 Cursor transport 测试在 1 秒初始化期限内超时；该文件独立检查和完整 56 文件复跑均通过，未修改其 timeout 或断言。不能将此前 757 项的通过当成最后两个退出回归已执行，也不把本次复跑描述为始终一次通过。

相关日志：`desktop-initialize-red.log`、`desktop-path-{red,green}.log`、`chromium-profile-{red,green}.log`、`native-oauth-routing-red.log`、`native-login-admission-cancel-red.log`、`native-recovery-drain-proof-red.log`、`native-startup-tests-final-clean.log`、`native-startup-tests-final-recheck.log`、`native-startup-cursor-recheck.log` 及 `native-startup-*-final*.log`。测试见 `native-official-integration.test.ts`，需显式设置 `CODEXHOST_TEST_OFFICIAL_CODEX` 和 `CODEXHOST_TEST_NATIVE_LAUNCHER`；它不会打开授权 URL、完成认证或调用真实 Model。

真实 Desktop 目前只证明隔离登录页能够显示，不等于已登录界面、阻断时的管理入口或其他 Harness GUI 已验收；原始用户启动的 unavailable 首因仍未取得那次原因日志。真实认证、系统密钥、同一真实 Thread A→B→A 与完整迁移仍是明确的后续门槛。本轮新的独立 pi 审查未启动：CLI 缺少合法 Host Runtime endpoint/token context；没有新子任务或审查结果。

## 原生协议证据的限度

本轮用 `0.153.4` 的 `app-server generate-ts --experimental` 在隔离空 HOME 中离线生成完整协议。默认输出省略 experimental 接口，曾导致 settings／queue 接口缺失的误判；完整生成后已纠正，未据此删除有效 API。

生成类型仅证明接口及字段声明存在。未据此声称真实账户已认证，或原生默认 `cli_auth_credentials_store` 已证明为 file。当前需原生有效配置明确报告 `file`；省略值仍安全降级为原生单账号，不自动改用户配置。设置恢复的原生实际运行仍待联合验收。

## 支持矩阵与未闭合门槛

| 项目 | 本轮证据 | 不应推断的结论 |
| --- | --- | --- |
| macOS 私有文件、锁、ACL、退出 helper | 实际 compiled-helper＋合成数据测试 | 真实 keyring 授权／锁定和 Desktop A→B→A 已验证 |
| Windows DACL／Job、Linux 原语 | 编译检查及可在本机运行的纯测试 | Windows/Linux native runtime 全通过 |
| 官方 `0.153.4`＋明确 file 模式 | 离线协议、fake 组合、实际受保护 listener 与未认证 OAuth 取消链路 | 所有版本、默认配置、真实认证和 Provider 均已验证 |
| 新安装／单一正式 home | 原地保留；不移动原生数据 | 多 home 已合并 |
| 旧多 home／foreign／损坏元数据 | `migration-required`，保留原件 | 已完成数据库、附件、记忆、队列或项目迁移 |
| 外部 Harness 连续性 | Host 路由及合成组合检查 | 真实多 Harness 长时间并行联合验收完成 |

未知 Codex 进程只保守拒绝，不自动杀死。文件路径校验是操作前后观察，不是抵御任意恶意同 UID 程序或阻止外部 CLI 以后启动的保证。macOS 对无害 deny-only ACL 也保守拒绝；任意网络文件系统语义未验证。

完整多 home 迁移、真实账号／额度刷新、系统密钥生命周期和 Desktop 跨平台验收仍未完成。因此这是可审查的实现 worktree，不是可宣称全面替代旧版本的发布成品。人类迁移阶段、采集值和不可逆动作确认需另行取得批准。
