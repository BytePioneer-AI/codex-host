# 账号与额度设置

在 codexhost 的「设置 → 账号」统一查看各 Agent 的账号与额度。当前仅支持 Codex 多账号管理；其他 Harness 的认证和切换仍由其原生客户端管理。

## 账号列表

页面只有一张「账号 / 5 小时额度 / 7 天额度 / 管理」表格，不再另设「其他已识别账号」区域。窄窗口下每个账号独立排列，两个额度窗口并排，最窄布局再纵向堆叠。视觉沿用原设置外壳：淡紫色终端标记、无边框搜索、行内默认操作与紧凑的管理入口。工具栏的「账号」数量包含 Codex 账号（包括待登录记录）和实际返回的其他 Harness 账号，不随搜索筛选改变。

- 主标题显示完整邮箱或账号名称，单行省略并可悬停查看完整身份；Agent 名称、真实套餐与「Codex 默认」标记作为次级信息，不显示本地 `CODEX_HOME` 路径。
- 搜索按邮箱、账号名称、Agent 或套餐筛选整个列表，仅在两类账号都不匹配时显示一个空状态。Codex 按 Host 返回顺序在前，其他 Harness 按稳定的 Harness ID 顺序在后；不按剩余额度或默认状态重排。
- 5 小时与 7 天额度分别对齐比较；周额度归入 7 天列。缺少的窗口仅显示「—」，不补成已用 0% 或剩余 100%。月额度、模型组及产品专属额度在账号信息下独立具名显示，不冒充全账号总额度，也不合并或丢弃重复报告。
- 默认按「剩余」展示，也可切换为「已用」，表头同步说明口径。进度条和数字使用相同口径，风险颜色仍按已用比例判断：70% 起警示，90% 起强调。
- 每个窗口在百分比旁显示弱化的倒计时，最多两个单位：超过一天为 `6d17h`，不足一天为 `4h54m`，不足一小时为 `14m`。下方右对齐显示本地时间 `09/15 10:08`；悬停和辅助技术可读取包含年份、时区的完整重置时间。无有效重置时间时不编造日期或倒计时。
- 页面本地每分钟及重新获得焦点时更新倒计时，不重新查询 Host、不重建账号行。到点只显示「待刷新」，不会自动把额度设为 100%；关闭设置后停止计时。
- 刷新额度只查询已登录账号。加载、读取失败、暂无数据分别展示；失败可重试，未知数据不按 0% 处理。单个账号的请求不会阻塞其他账号的额度展示，页面关闭后的响应不会更新页面。
- 套餐类型来自 Codex 官方 `account/read.planType`，`prolite` 按当前产品对应关系高亮显示为 Pro 5x，`pro` 高亮显示为 Pro 20x；Plus、Team 等保持普通标签，`unknown` 不显示。5x/20x 是展示层映射，不改变协议原值。官方接口不提供订阅续期时间，因此不显示续期日期。

## 其他 Harness 的只读账号额度

统一列表中展示 Grok Build、agy（Antigravity）、Claude Code 当前原生认证可读取的真实额度。每行管理列标明「原生管理」，信息按钮解释其管理边界。这不是多账号管理：不提供添加、删除、切换、设为默认或重置卡操作，也不修改 Codex 默认账号与 Thread 路由。搜索和已用/剩余切换作用于所有行，刷新按钮重新查询两类额度。

- 仅在返回有效额度窗口时显示账号。API Key、第三方 Provider、未登录、无可用数据或查询失败时不显示占位行。刷新后不复用上一份账号额度，避免退出或改变认证后展示旧账号。
- 左侧展示 Harness Logo；主标题优先显示邮箱或可识别名称，Harness 名称和套餐作为次级信息。没有账号身份时以 Harness 名称为主标题，不重复名称或显示「当前登录账号」，不会猜测邮箱。邮箱按列宽省略，悬停可查看完整身份。不记录或展示账号快照更新时间；原型中的示例套餐不作为真实数据来源。
- Grok Build 复用原生 xAI OAuth 认证和 billing 查询，展示周期、重置时间及产品用量；不将其他 issuer 的 Token 发到 xAI。套餐使用比例优先读取 `creditUsagePercent`；省略时按原生规则使用旧版套餐额度 `monthlyLimit` / `used`，没有正数套餐上限但有可识别的周/月周期及有效重置时间时，按原生零用量语义展示已用 0% / 剩余 100%，保留账号行。请求失败、空配置或异常用量字段不补成 0%；不使用 `onDemandCap` / `onDemandUsed` 的按需消费金额替代套餐比例。显式配置 `XAI_API_KEY`、`GROK_API_KEY` 或 `GROK_TOKEN` 时保守地不展示保存的 OAuth 账号。此页展示 Harness 账号额度，不判定某个 Thread 的逐模型凭据或实际 Billing Source。
- agy 执行原生 `--print=/usage --output-format stream-json`，由 CLI 自己解析认证，展示实际模型组与窗口。当前该输出不提供账号邮箱或套餐，以 Harness 名称为主标题。
- Claude Code 使用 Agent SDK 0.3.220 的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` 主动查询，并通过 `accountInfo()` 读取身份。仅投影 `rate_limits_available` 为真且有效的套餐窗口，包括原生返回的模型独立窗口；不将 session Token、会话花费或额外用量金额混为额度百分比。当前不展示 `extra_usage` 金额。旧 SDK/CLI 不支持该实验性操作时不展示。
- 查询不需要已有 Thread，不发起 Model Turn；Claude SDK 检查使用空输入流、无工具且不持久化 Session，并在成功、失败、超时后关闭检查进程。Broker 路径转发同一个只读能力。

公共数据链路是 `HarnessAdapter.inspectAccount()` → `codexhost/harness/accounts/list` → 设置页。账号快照只有可展示身份、套餐与额度，无凭据、原生路径或原始 SDK 对象；Host 不直接依赖具体 Adapter。仅查询当前 Host 已加载插件，单插件失败不会阻断其他账号。

## 重置卡

有重置卡快照时，在 Codex 行的管理列显示「重置卡 N 张」入口，点击可展开最近到期时间、接口提供的逐张到期清单以及「使用重置」操作。不单独占用表格列；没有重置卡数据时不显示入口，也不推断为零张。

消耗重置卡前保留确认提示，使用期间禁止重复消耗，结果由原有 Host 接口返回。额度重置时间与重置卡到期时间是两类独立信息。

## 默认账号、删除与登录

「设为默认」只影响之后新建的 Codex 任务，已有任务保持原账号。提交期间按钮禁用、切换成功后按钮消失时，焦点保留在当前账号行，不跳到搜索框；账号行不增加常规 Tab 停靠点。

正式数据中的两个标记含义不同：

- `active`：用于之后新建任务的账号，对应界面的默认标记。
- `isDefault`：原生账号目录的保护标记。该账号不显示删除入口，即使当前 `active` 指向另一个账号。

Codex 行的省略号入口打开账号操作，可单独刷新额度；非受保护账号还可删除，并保留不可撤销确认。没有可用操作时不显示空入口。删除正在使用的非受保护账号时，保持现有 Host 规则，回退到原生账号；UI 不增加自动挑选其他账号的策略。

添加按钮明确为「添加 Codex 账号」。添加账号、打开验证链接、复制设备代码和取消登录仍使用现有原生登录流程，不收集额外凭据。

Windows Desktop / Remote Control 的官方后台按账号 `CODEX_HOME` 隔离；只有同一账号的多个连接共享监听进程。新增账号不能连接原生账号的后台，也不能通过读取原生账号资料被误判为已登录。监听进程随 Host 退出统一关闭。

## 用量浮窗

用量浮窗不重复展示 5 小时和 7 天额度；额度继续由专属额度入口展示。

选择 Codex 时，用量浮窗显示当前任务所选账号的完整邮箱（无邮箱时显示账号名称）。新任务跟随账号选择，已有任务显示其绑定账号；切换 Host 后跟随该 Host 的账号状态。即使尚无 Token 用量，也可通过「用量」入口查看账号。其他 Harness 或无法确认账号归属时不显示 Codex 账号。

## 实现与验证

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
