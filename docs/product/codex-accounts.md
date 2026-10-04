# 账号与额度设置

在 codexhost 的「设置 → 账号」查看当前 Codex 身份与额度，以及其他 Harness 的 `inspectAccount()` 快照。CodexHost 不管理多个原生 Codex 登录：不提供添加/登录/切换/退出/删除/恢复，也不消耗重置卡。官方 Desktop 登录与退出仍由官方后端处理。账号页只读展示身份与额度，不再提供凭证导入或 Pi 登录配置管理入口。已有 Pi 配置保持不变，请在 Pi 原生客户端中管理。

本地 `.codexhost-native-accounts` 文件若仍存在，启动和刷新都不会读取、改写或回收。

## 账号列表

页面使用「账号 / 剩余额度（或已用额度）」表格，两个表头居中，额度区域保留两列并共用不绑定周期的表头。不显示「用于 Harness」列和「Pi 中的账号」专区，也不发起凭证导入记录查询。全局刷新在工具栏，原生管理边界以身份的悬停提示保留。窄窗口下每个账号独立排列，两个额度窗口并排，单个额度横跨整个额度区域，最窄布局再纵向堆叠。视觉沿用原设置外壳：无边框搜索、全局额度刷新。所有账号行统一使用各自的产品 Logo。工具栏的「账号」数量包含当前 Codex 账号和实际返回的其他 Harness 账号，不随搜索筛选改变。

- 主标题显示完整邮箱或账号名称，单行省略并可悬停查看完整身份；Agent 名称、真实套餐与「Codex 当前」标记作为次级信息，不显示本地 `CODEX_HOME` 路径。
- 搜索按邮箱、账号名称、Agent 或套餐筛选整个列表，仅在两类账号都不匹配时显示一个空状态。Codex 按 Host 返回顺序在前，其他 Harness 通常按稳定的 Harness ID 顺序排列，Antigravity CLI 固定放在这些 Harness 的最后；不按剩余额度或当前状态重排。
- 每条额度进度条独立显示类别与周期。仅排列真实返回的窗口，每行最多两个：Cursor 的 Auto 与 API 月额度并排，Kimi 的周额度与 5 小时额度同样并排，不按通用/模型范围强制拆成两行。只有一个窗口（包括额外行的单项窗口）时横跨两列，不保留空窗口占位。超过两项时继续换行，不挤入账号信息。不为缺少的窗口补成已用 0% 或剩余 100%；不冒充全账号总额度，也不合并或丢弃重复报告。
- 默认按「剩余」展示，也可切换为「已用」，表头同步说明口径。进度条和数字使用相同口径，风险颜色仍按已用比例判断：70% 起警示，90% 起强调。
- 每个窗口在百分比旁显示弱化的倒计时，最多两个单位：超过一天为 `6d17h`，不足一天为 `4h54m`，不足一小时为 `14m`。下方右对齐显示本地时间 `09/15 10:08`；悬停和辅助技术可读取包含年份、时区的完整重置时间。无有效重置时间时不编造日期或倒计时。
- 页面本地每分钟及重新获得焦点时更新倒计时，不重新查询 Host、不重建账号行。到点只显示「待刷新」，不会自动把额度设为 100%；关闭设置后停止计时。
- Codex 当前额度来自官方 `account/rateLimits/read`。加载、读取失败、暂无数据分别展示；失败可重试，未知数据不按 0% 处理。页面关闭后的响应不会更新页面。
- Codex 套餐类型来自官方当前身份。`prolite` 按当前产品对应关系高亮显示为 Pro 5x，`pro` 高亮显示为 Pro 20x；Plus、Team 等保持普通标签，`unknown` 不显示。5x/20x 是展示层映射，不改变协议原值。官方接口不提供订阅续期时间，因此不显示续期日期。

菜单栏 / 任务栏的当前 Codex 额度展示保持现有行为；本次不新增展示面或刷新机制。

## Codex 额度与外部 Harness 发送

ChatGPT 登录的 Codex 订阅额度耗尽时，Desktop 在 Renderer 中用两道账号级布尔门禁用 Composer 提交：账号额度门和 reserve `hardBlocked`。API Key 登录不经过这两道门。它们是界面上的订阅额度预检，不是协议限制；外部 Harness 的 `turn/start` 由 Host 路由，不会发到官方后端。

因此在单个 Composer 选中外部 Agent、Adapter 就绪且没有 codexhost 自身的提交阻塞时，`renderer-codex-usage-gate.ts` 只把该 Composer 对这两道门的订阅快照投影为 `false`，继续走原生提交链路。不写账号、atom 或额度查询缓存，Codex 额度横幅保持显示；其他 Composer、Codex 路径和空输入、附件、运行中等其他原生限制不受影响。外部 Harness 的真实额度与错误由其自身处理。切回 Codex、Composer 移除或扩展卸载时恢复实时原生结果。

门按其 selector 实际读取的字段识别，不依赖压缩名或 hook 序号。兼容直接 `[store, atom]` 订阅及 Desktop 26.928 的 readonly signal adapter / lazy snapshot wrapper：以成对的订阅 effect 和原生快照一致性验证 wrapper，限量重放 readonly 布尔 selector 的依赖以识别间接 reserve 门；拒绝循环依赖、追踪型 render、混合门和快照不匹配。释放时分别恢复 subscriber 与 React instance 原来的 getter，不把 wrapper 替换成另一个函数。无法唯一识别时保留原生限制，并在 Agent 控件悬停提示中说明。升级后的诊断步骤见 [Desktop 更新兼容性诊断手册](../operations/codex-desktop-upgrade-diagnosis-playbook.md#检查-codex-额度门)。

## 其他 Harness 的只读账号额度

统一列表中展示 Grok Build、agy（Antigravity）、Claude Code、Cursor、Kimi Code、Qoder 和 Pi 当前原生认证可读取的真实额度或预付费余额。不再显示目标 Harness 列；原生管理边界保留在账号信息的说明中。这不是多账号管理：不提供添加、删除、切换、设为默认或重置卡操作，也不修改 Codex 当前账号。搜索和已用/剩余切换作用于所有行，刷新按钮重新查询两类额度。各 Harness 独立并行查询，任一有效结果返回后立即显示，不等待其他 Harness；全局刷新期间同样逐项恢复。

- 仅在返回有效额度窗口或预付费余额时显示账号。API Key 或第三方 Provider 不自动代表存在套餐额度；未登录、无可用数据或查询失败时不显示占位行。Host 按 Harness 缓存完成的账号检查结果 15 秒，关闭后立即重开设置页可复用该短期结果；工具栏「刷新额度」显式绕过缓存，刷新后不复用上一份账号额度，避免退出或改变认证后展示旧账号。
- 左侧展示各 Harness/供应商的产品 Logo；主标题优先显示邮箱或可识别名称，Harness 名称和套餐作为次级信息。没有账号身份时以 Harness 名称为主标题，不重复名称或显示「当前登录账号」，不会猜测邮箱。邮箱按列宽省略，悬停可查看完整身份。不记录或展示账号快照更新时间；原型中的示例套餐不作为真实数据来源。预付费余额没有套餐上限或重置时间，因此只显示 Provider 返回的金额和币种，不编造百分比。
- Pi 在配置了 DeepSeek API Key 时显示该 Provider 报告的预付费余额。`models.json` 中带 API Key 和 base URL 的自定义 Provider 会向该站点自己的 `GET /v1/usage` 查询 sub2api 钱包或 Key 额度；只有响应明确给出币种和非负可用金额时才显示。Key 只发送给用户配置的站点且不跟随重定向。一个 Pi 可报告多个 Billing Source，Host 最多投影八个独立账号行。
- Cursor 使用原生 OAuth 凭据读取 DashboardService 的 Auto 与 API 月度比例和账期结束时间；API Key 与内存凭据模式不读取无关的已保存 OAuth。Kimi Code 读取 coding usages，原生 Token 过期或接口返回 401 时通过原 refresh token 刷新并更新原生凭据文件。Qoder 通过 SDK `getUsageInfo()` 与 `accountInfo()` 读取套餐 Credits、身份以及共享资源包；不会把 Session 累计消耗冒充账号额度。
- Grok Build 复用原生 xAI OAuth 认证和 billing 查询，展示周期、重置时间及产品用量；不将其他 issuer 的 Token 发到 xAI。套餐使用比例优先读取 `creditUsagePercent`；省略时按原生规则使用旧版套餐额度 `monthlyLimit` / `used`，没有正数套餐上限但有可识别的周/月周期及有效重置时间时，按原生零用量语义展示已用 0% / 剩余 100%，保留账号行。请求失败、空配置或异常用量字段不补成 0%；不使用 `onDemandCap` / `onDemandUsed` 的按需消费金额替代套餐比例。显式配置 `XAI_API_KEY`、`GROK_API_KEY` 或 `GROK_TOKEN` 时保守地不展示保存的 OAuth 账号。此页展示 Harness 账号额度，不判定某个 Thread 的逐模型凭据或实际 Billing Source。
- agy 执行原生 `--print=/usage --output-format stream-json`，由 CLI 自己解析认证，展示实际模型组与窗口。当前该输出不提供账号邮箱或套餐，以 Harness 名称为主标题。
- Claude Code 使用 Agent SDK 0.3.220 的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` 主动查询，并通过 `accountInfo()` 读取身份。仅投影 `rate_limits_available` 为真且有效的套餐窗口，包括原生返回的模型独立窗口；不将 session Token、会话花费或额外用量金额混为额度百分比。当前不展示 `extra_usage` 金额。旧 SDK/CLI 不支持该实验性操作时不展示。
- 查询不需要已有 Thread，不发起 Model Turn；Claude SDK 检查使用空输入流、无工具且不持久化 Session，并在成功、失败、超时后关闭检查进程。Broker 路径转发同一个只读能力。

公共数据链路是 `HarnessAdapter.inspectAccount()` / `inspectAccounts()` → `codexhost/harness/accounts/sources` / `codexhost/harness/accounts/inspect` → 设置页；旧 Host 仍可回退到聚合的 `codexhost/harness/accounts/list`。`inspectAccounts()` 只用于一个 Harness 同时报告多个 Billing Source，兼容字段 `account` 始终保留第一项。渐进式与聚合路由共享同一份按 Harness 的 15 秒缓存和在途请求。账号快照只有可展示身份、套餐、额度或余额，无凭据、原生路径或原始 SDK 对象；Host 不直接依赖具体 Adapter。仅查询当前 Host 已加载插件，单插件失败或超时不会阻断其他账号的返回与展示。

## Pi 凭证配置边界

账号页不再挂载凭证导入图标、对话框及「Pi 中的账号」专区。删除展示入口不会删除已经导入的凭证、Provider 扩展或记录，也不会改写 Pi 原有配置。后端公共凭证导入契约和独立实现仍保留，但此页不提供操作入口；Pi 登录与 Provider 配置由其原生客户端管理。

## 重置卡

有重置卡快照时，在 Codex 行的账号信息下显示「重置卡 N 张」入口，点击可展开最近到期时间以及接口提供的逐张到期清单。不单独占用表格列；没有重置卡数据时不显示入口，也不推断为零张。CodexHost 不提供「使用重置」，也不调用官方消耗接口。额度重置时间与重置卡到期时间是两类独立信息。

## 官方认证

Desktop `account/login/*` 和 `account/logout` 原样交给官方后端。Host 不建立凭据收藏库；仅用户确认的导入写入目标 Harness 自己的存储。不替换 loginId，不重建原生结果。官方认证完成后，设置页可更新当前身份与额度展示。

SSH 维持远端原生单账号，不传输本地凭据。

## 用量浮窗

用量浮窗不重复展示 5 小时和 7 天额度；额度继续由专属额度入口展示。

选择 Codex 时，用量浮窗只读显示当前 Host 的全局账号身份，而不是 Thread 的历史绑定。切换 Host 后跟随相应 Host 的状态。即使尚无 Token 用量，也可查看当前身份；其他 Harness 不显示 Codex 账号。

## 实现与验证

- `docs/product/codex-native-account-switching-design.md`：多账号能力已删除后的只读额度边界。
- `openspec/changes/remove-codex-multi-account/`：删除 Host 多账号管理的产品契约。
- `packages/host-runtime/src/account/codex-account-control.ts`：当前官方身份的只读投影。
- `packages/host-runtime/src/native-account-host.ts`：本地当前身份读取。
- `packages/host-runtime/src/native-account-observer.ts`：原生认证后更新显示身份，不收藏凭据。
- `packages/renderer-extension/src/settings/accounts-page.ts`：只读身份与额度页面。
- `packages/renderer-extension/src/settings/credential-imports.ts`：保留的独立凭证导入组件；账号页不再挂载。
- `packages/adapters/pi/src/pi-credential-imports.ts`：Pi 原生存储和导入配置所有权管理。
- `packages/host-runtime/src/credential-imports.ts`：通过公共 Adapter 契约路由后端凭证转移。
- `packages/renderer-extension/src/settings/accounts-list.ts`：统一账号行与重置卡数量展开。
- `packages/renderer-extension/src/settings/accounts-usage.ts`：额度窗口分列、额外具名额度和重置卡详情。
- `packages/renderer-extension/src/settings/accounts-reset-time.ts`：紧凑重置时间与页面本地倒计时。
- `packages/renderer-extension/src/settings/harness-accounts.ts`：其他 Harness 只读账号查询状态。
- `packages/host-runtime/src/harness-accounts.ts`：公共只读账号聚合与校验。
- `packages/shared-contracts/src/harness-accounts.ts`：浏览器安全的只读快照与请求契约。
- `packages/renderer-extension/src/settings/accounts.css`：明暗主题及窄窗口布局。
- `packages/renderer-extension/test/settings/`：设置页及额度单元测试。
- `tests/e2e/renderer-settings-accounts.spec.ts`：真实设置外壳与真实渲染代码，使用隔离的模拟客户端验证布局和交互；不连接真实账号服务。
