# 账号与额度设置

在 codexhost 的「设置 → 账号」统一查看各 Harness 的账号与额度。Codex 托管账号使用一份正式会话存储和最多一个官方后台；其他 Harness 的认证和切换仍由其原生客户端管理。

> 当前实现处于验收阶段，不是旧多 home 安装的通用升级版本。托管路径暂以官方 `0.153.4` 的文件式 ChatGPT 登录为能力基线；真实账号、系统凭据存储和各平台 Desktop 联合验收尚未完成。旧多 home 的完整迁移仍是发布门槛，检测到该布局会阻止 Codex 启用，而不是遗漏历史后继续。

## 账号列表

页面只有一张「账号 / 5 小时额度 / 7 天额度 / 管理」表格，不再另设「其他已识别账号」区域。窄窗口下每个账号独立排列，两个额度窗口并排，最窄布局再纵向堆叠。视觉沿用原设置外壳：淡紫色终端标记、无边框搜索、行内默认操作与紧凑的管理入口。工具栏的「账号」数量包含已保存的 Codex 账号和实际返回的其他 Harness 账号，不随搜索筛选改变。

- 主标题显示完整邮箱或账号名称，单行省略并可悬停查看完整身份；Agent 名称、真实套餐与「Codex 当前」标记作为次级信息，不显示本地 `CODEX_HOME` 路径。
- 搜索按邮箱、账号名称、Agent 或套餐筛选整个列表，仅在两类账号都不匹配时显示一个空状态。Codex 按 Host 返回顺序在前，其他 Harness 按稳定的 Harness ID 顺序在后；不按剩余额度或当前状态重排。
- 5 小时与 7 天额度分别对齐比较；周额度归入 7 天列。缺少的窗口仅显示「—」，不补成已用 0% 或剩余 100%。月额度、模型组及产品专属额度在账号信息下独立具名显示，不冒充全账号总额度，也不合并或丢弃重复报告。
- 默认按「剩余」展示，也可切换为「已用」，表头同步说明口径。进度条和数字使用相同口径，风险颜色仍按已用比例判断：70% 起警示，90% 起强调。
- 每个窗口在百分比旁显示弱化的倒计时，最多两个单位：超过一天为 `6d17h`，不足一天为 `4h54m`，不足一小时为 `14m`。下方右对齐显示本地时间 `09/15 10:08`；悬停和辅助技术可读取包含年份、时区的完整重置时间。无有效重置时间时不编造日期或倒计时。
- 页面本地每分钟及重新获得焦点时更新倒计时，不重新查询 Host、不重建账号行。到点只显示「待刷新」，不会自动把额度设为 100%；关闭设置后停止计时。
- Codex 额度查询不以邮箱是否存在筛选账号；无邮箱的已保存账号仍可查询和刷新。加载、读取失败、暂无数据分别展示；失败可重试，未知数据不按 0% 处理。单个账号的请求不会阻塞其他账号的额度展示，页面关闭后的响应不会更新页面。
- Codex 套餐类型来自经原生认证验证的账号信息，`prolite` 按当前产品对应关系高亮显示为 Pro 5x，`pro` 高亮显示为 Pro 20x；Plus、Team 等保持普通标签，`unknown` 不显示。5x/20x 是展示层映射，不改变协议原值。官方接口不提供订阅续期时间，因此不显示续期日期。

## 其他 Harness 的只读账号额度

统一列表中展示 Grok Build、agy（Antigravity）、Claude Code 当前原生认证可读取的真实额度。每行管理列标明「原生管理」，信息按钮解释其管理边界。这不是多账号管理：不提供添加、删除、切换、设为默认或重置卡操作，也不修改 Codex 当前账号。搜索和已用/剩余切换作用于所有行，刷新按钮重新查询两类额度。

- 仅在返回有效额度窗口时显示账号。API Key、第三方 Provider、未登录、无可用数据或查询失败时不显示占位行。刷新后不复用上一份账号额度，避免退出或改变认证后展示旧账号。
- 左侧展示 Harness Logo；主标题优先显示邮箱或可识别名称，Harness 名称和套餐作为次级信息。没有账号身份时以 Harness 名称为主标题，不重复名称或显示「当前登录账号」，不会猜测邮箱。邮箱按列宽省略，悬停可查看完整身份。不记录或展示账号快照更新时间；原型中的示例套餐不作为真实数据来源。
- Grok Build 复用原生 xAI OAuth 认证和 billing 查询，展示周期、重置时间及产品用量；不将其他 issuer 的 Token 发到 xAI。套餐使用比例优先读取 `creditUsagePercent`；省略时按原生规则使用旧版套餐额度 `monthlyLimit` / `used`，没有正数套餐上限但有可识别的周/月周期及有效重置时间时，按原生零用量语义展示已用 0% / 剩余 100%，保留账号行。请求失败、空配置或异常用量字段不补成 0%；不使用 `onDemandCap` / `onDemandUsed` 的按需消费金额替代套餐比例。显式配置 `XAI_API_KEY`、`GROK_API_KEY` 或 `GROK_TOKEN` 时保守地不展示保存的 OAuth 账号。此页展示 Harness 账号额度，不判定某个 Thread 的逐模型凭据或实际 Billing Source。
- agy 执行原生 `--print=/usage --output-format stream-json`，由 CLI 自己解析认证，展示实际模型组与窗口。当前该输出不提供账号邮箱或套餐，以 Harness 名称为主标题。
- Claude Code 使用 Agent SDK 0.3.220 的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` 主动查询，并通过 `accountInfo()` 读取身份。仅投影 `rate_limits_available` 为真且有效的套餐窗口，包括原生返回的模型独立窗口；不将 session Token、会话花费或额外用量金额混为额度百分比。当前不展示 `extra_usage` 金额。旧 SDK/CLI 不支持该实验性操作时不展示。
- 查询不需要已有 Thread，不发起 Model Turn；Claude SDK 检查使用空输入流、无工具且不持久化 Session，并在成功、失败、超时后关闭检查进程。Broker 路径转发同一个只读能力。

公共数据链路是 `HarnessAdapter.inspectAccount()` → `codexhost/harness/accounts/list` → 设置页。账号快照只有可展示身份、套餐与额度，无凭据、原生路径或原始 SDK 对象；Host 不直接依赖具体 Adapter。仅查询当前 Host 已加载插件，单插件失败不会阻断其他账号。

## 重置卡

有重置卡快照时，在 Codex 行的管理列显示「重置卡 N 张」入口，点击可展开最近到期时间、接口提供的逐张到期清单以及「使用重置」操作。不单独占用表格列；没有重置卡数据时不显示入口，也不推断为零张。

只允许当前 Codex 账号消耗重置卡。消耗前保留确认提示，使用期间禁止重复消耗，不自动重试，结果由官方接口返回。额度重置时间与重置卡到期时间是两类独立信息。

## 全局切换、删除与登录

「切换到此账号」作用于当前 Host 的所有 Codex Thread，包括已有 Thread 的后续 Turn。切换不改变 Thread ID、历史、Model、Provider、目录或权限；不改变其他 Harness。已有上下文会随下一次请求用于新账号，账号不再是独立数据空间，也不等于实际 Billing Source。

只有空闲时才切换：关闭新工作准入，停止并确认官方进程树退出，保存实际最新凭据，原子替换原生凭据，再启动并验证。忙碌、审批、终端、队列等未结束时明确拒绝；不强制取消、不排队、不重放输入。已有、已完成且可恢复的 Thread 本身不算忙；临时或尚未落盘的内存 Thread 无法保证跨重启保留，也会拒绝切换。原生返回一个计划中的历史路径不代表已经落盘。Desktop 和 Host 不因切换重启。Harness picker 只有一个 Codex，Composer 不提供账号选择。

删除仅允许非当前保存账号，保留确认，不删除任何 Thread 或 home，也不自动选择其他账号。受控「退出登录」保存当前最新凭据后清除原生登录，已保存账号仍可再次选择；退出和删除不同。

「添加 Codex 账号」使用原生设备代码登录。开始前停止任务后台，在私有、短命的认证 staging 目录中启动唯一登录后台，不执行用户任务。添加 B 不覆盖正式 home 中的 A，结束后仍使用 A；此前未登录时，首次成功登录成为当前账号。当前账号重新登录也必须安装新授权，不能因为 ID 相同跳过。

Desktop 原生「登录」保留 OAuth 和设备代码两种 ChatGPT 协议，复用同一个 staging 和事务；与设置页「添加」不同，原生登录成功会使用本次登录的身份。原生完成通知不会早于启动应答；只有正式后台确实就绪才报告原生登录成功，并从该后台读取账号信息通知 Desktop 更新。不能把已保存但待恢复的账号冒充已登录。

已保存账号的「登录」入口可重新获取授权，邮箱缺失不代表未认证。完成事件按本次登录操作对账，即使早于启动应答也能处理；轮询只更新快照，不凭旧邮箱推断成功。操作已经结束但完成结果未收到时，显示「登录结果未确认」，请检查已保存账号状态。

取消、超时和迟到事件绑定本次登录操作。账号已保存但清理或正式后台恢复失败时，页面明确显示已保存和待恢复，不能把它当成账号未保存。`recover` 重试事实恢复，不强制删除 Journal 或覆盖未知凭据；不能安全确定所有权时仅 Codex unavailable，其他 Harness 保持运行。

Desktop 的 Host 连接初始化与 Codex 就绪状态分开：Codex unavailable 或正在切换时，Host 只返回自身身份、正式 home 和运行平台，不启动额外后台、不宣称认证成功，也不把 Desktop 接入认证 staging。原生请求仍受准入限制；恢复后同一个 Desktop 连接使用保留的原生初始化参数继续工作。终端会以固定原因说明启动被阻断或检测到其他原生 Codex 进程，不输出凭据。

本地托管模式统一使用受保护的官方 loopback listener，专用管理连接先于 Desktop 初始化。多连接仍只有一个后台。SSH 维持远端原生单账号，不传输本地凭据。不支持管理但无未决事务时保留原生单账号认证；该模式不承诺托管账号库能跟踪原生客户端自行更换或删除的凭据。

## 存储、安全与升级边界

- Launcher 显式传递所支持的绝对 home／配置路径；指定 `CODEX_ELECTRON_USER_DATA_PATH` 时也传递 Chromium 的 `--user-data-dir`，避免只隔离部分 Electron 数据。不会把 API Key 等秘密拼入启动参数，也不把 SSH 管理环境的目录覆盖带入本地 Desktop。
- 正式 `CODEX_HOME` 固定。当前凭据的权威是原生文件；非当前凭据使用 OS 密钥和 AES-256-GCM 保存在 `.codexhost-native-accounts/vault.json`，不另建长期账号 home。
- `transaction.json` 和 `login.json` 记录未决操作，秘密备份同样加密。已有 Vault 缺失密钥时不生成替代密钥、不退回明文。密钥命名空间为 `codexhost.native-accounts.v1`。
- 文件 helper 持有 home 租约，并在同一进程中执行有界 I/O；退出未确认时不能让新写入者越过租约。可观察到的其他 Codex 进程会保守阻止托管操作，不杀未知进程。这个检查不能阻止任意外部 CLI 以后启动或同用户程序自行写文件。
- 公开快照只有 `ready/changing/unavailable`、已提交 current、能力、Host instance/revision 和必要清理提示，不含 Token 或存储路径。unavailable 时 current 不是后台已经可用的证明。
- 非当前额度通过受控 WHAM 查询，不启动额外后台。OAuth 刷新有 single-flight、修改租约和凭据 CAS；缓存显示获取时间，失败使用 last-good，不把未知用量补成零。
- 新安装和已有单一正式 home 原地使用，不复制历史。旧多 home、损坏元数据、外部 home 或孤立 Thread 绑定明确阻止升级，原件不删除。完整数据库、附件、记忆、队列、项目关系迁移及用户确认流程尚未交付；不要用只复制 rollout 代替迁移。

容量预算：每份原生凭据 256 KiB，Vault 4 MiB，Journal 17 MiB，通用私有文件 20 MiB；最多 128 个保存账号。实际可保存数量也受字节预算约束。

## 用量浮窗

用量浮窗不重复展示 5 小时和 7 天额度；额度继续由专属额度入口展示。

选择 Codex 时，用量浮窗只读显示当前 Host 的全局账号身份，而不是 Thread 的历史绑定。切换 Host 后跟随相应 Host 的状态。即使尚无 Token 用量，也可查看当前身份；其他 Harness 不显示 Codex 账号。

## 实现与验证

- `docs/codex-native-account-switching-design.md`：设计、核心参考及发布验收边界。
- `openspec/changes/implement-codex-native-accounts/evidence.md`：已执行验证、故障回归和未闭合发布门槛。
- `packages/host-runtime/src/account/native-codex-accounts.ts`：唯一账号控制面和隔离登录。
- `packages/host-runtime/src/account/native-profile-transaction.ts`：切换、退出、重登和事实恢复。
- `packages/host-runtime/src/account/native-account-store.ts`：统一 Vault、加密 Journal 和 staging。
- `packages/host-runtime/src/native-account-host.ts`：本地能力、所有权与降级组成。
- `packages/host-runtime/src/managed-native-auth.ts`：原生登录协议、事件顺序和正式后台代次更新；不另持凭据或管理进程。
- `packages/renderer-extension/src/settings/accounts-page.ts`：账号生命周期、查询、登录与操作。
- `packages/renderer-extension/src/settings/accounts-list.ts`：统一账号行、管理入口与重置卡展开。
- `packages/renderer-extension/src/settings/accounts-usage.ts`：额度窗口分列、额外具名额度和重置卡详情。
- `packages/renderer-extension/src/settings/accounts-reset-time.ts`：紧凑重置时间与页面本地倒计时。
- `packages/renderer-extension/src/settings/accounts-details.ts`：账号操作和原生管理说明对话框。
- `packages/renderer-extension/src/settings/harness-accounts.ts`：其他 Harness 只读账号查询状态。
- `packages/host-runtime/src/harness-accounts.ts`：公共只读账号聚合与校验。
- `packages/shared-contracts/src/harness-accounts.ts`：浏览器安全的只读快照与请求契约。
- `packages/renderer-extension/src/settings/accounts.css`：明暗主题及窄窗口布局。
- `packages/renderer-extension/test/settings/`：设置页及额度单元测试。
- `tests/e2e/renderer-settings-accounts.spec.ts`：真实设置外壳与真实渲染代码，使用隔离的模拟客户端验证布局和交互；不连接真实账号服务。
