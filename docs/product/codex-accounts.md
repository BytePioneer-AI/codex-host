# 账号与额度设置

在 codexhost 的「设置 → 账号」查看当前 Codex 身份与额度，以及其他 Harness 的 `inspectAccount()` 快照。CodexHost 不管理多个原生 Codex 登录：不提供添加/登录/切换/退出/删除/恢复，也不消耗重置卡。官方 Desktop 登录与退出仍由官方后端处理。用户可以显式确认，将兼容的本地授权一次性复制到 Pi 的独立 Provider 配置；这是对原先全页只读边界的有限扩展，不建立 Host 凭据库，也不改变原生登录。

本地 `.codexhost-native-accounts` 文件若仍存在，启动和刷新都不会读取、改写或回收。

## 账号列表

页面上方是「账号 / 5 小时额度 / 7 天额度 / 用于 Harness」表格，下方是「Pi 中的账号」专区。「用于 Harness」列只放可导入目标的小 Pi 图标；不再有逐行「刷新额度」或「原生管理」入口（全局刷新在工具栏，原生管理边界只以身份的悬停提示保留）。窄窗口下每个账号独立排列，图标移到该账号行右上角；两个额度窗口并排，最窄布局再纵向堆叠。视觉沿用原设置外壳：无边框搜索、全局额度刷新。所有账号行统一使用各自的产品 Logo（Codex 用官方 Codex 图标，不再是自绘的紫色终端方块），Pi 专区中识别出的供应商使用同一份 Logo。工具栏的「账号」数量包含当前 Codex 账号和实际返回的其他 Harness 账号，不随搜索筛选改变。

- 主标题显示完整邮箱或账号名称，单行省略并可悬停查看完整身份；Agent 名称、真实套餐与「Codex 当前」标记作为次级信息，不显示本地 `CODEX_HOME` 路径。
- 搜索按邮箱、账号名称、Agent 或套餐筛选整个列表，仅在两类账号都不匹配时显示一个空状态。Codex 按 Host 返回顺序在前，其他 Harness 通常按稳定的 Harness ID 顺序排列，Antigravity CLI 固定放在这些 Harness 的最后；不按剩余额度或当前状态重排。
- 5 小时与 7 天额度分别对齐比较；周额度归入 7 天列。缺少的窗口仅显示「—」，不补成已用 0% 或剩余 100%。月额度、模型组及产品专属额度在账号信息下独立具名显示，不冒充全账号总额度，也不合并或丢弃重复报告。
- 默认按「剩余」展示，也可切换为「已用」，表头同步说明口径。进度条和数字使用相同口径，风险颜色仍按已用比例判断：70% 起警示，90% 起强调。
- 每个窗口在百分比旁显示弱化的倒计时，最多两个单位：超过一天为 `6d17h`，不足一天为 `4h54m`，不足一小时为 `14m`。下方右对齐显示本地时间 `09/15 10:08`；悬停和辅助技术可读取包含年份、时区的完整重置时间。无有效重置时间时不编造日期或倒计时。
- 页面本地每分钟及重新获得焦点时更新倒计时，不重新查询 Host、不重建账号行。到点只显示「待刷新」，不会自动把额度设为 100%；关闭设置后停止计时。
- Codex 当前额度来自官方 `account/rateLimits/read`。加载、读取失败、暂无数据分别展示；失败可重试，未知数据不按 0% 处理。页面关闭后的响应不会更新页面。
- Codex 套餐类型来自官方当前身份。`prolite` 按当前产品对应关系高亮显示为 Pro 5x，`pro` 高亮显示为 Pro 20x；Plus、Team 等保持普通标签，`unknown` 不显示。5x/20x 是展示层映射，不改变协议原值。官方接口不提供订阅续期时间，因此不显示续期日期。

菜单栏 / 任务栏的当前 Codex 额度展示保持现有行为；本次不新增展示面或刷新机制。

## Codex 额度与外部 Harness 发送

ChatGPT 登录的 Codex 订阅额度耗尽时，Desktop 在 Renderer 中用两道账号级布尔门禁用 Composer 提交：账号额度门和 reserve `hardBlocked`。API Key 登录不经过这两道门。它们是界面上的订阅额度预检，不是协议限制；外部 Harness 的 `turn/start` 由 Host 路由，不会发到官方后端。

因此在单个 Composer 选中外部 Agent、Adapter 就绪且没有 codexhost 自身的提交阻塞时，`renderer-codex-usage-gate.ts` 只把该 Composer 对这两道门的订阅快照投影为 `false`，继续走原生提交链路。不写账号、atom 或额度查询缓存，Codex 额度横幅保持显示；其他 Composer、Codex 路径和空输入、附件、运行中等其他原生限制不受影响。外部 Harness 的真实额度与错误由其自身处理。切回 Codex、Composer 移除或扩展卸载时恢复实时原生结果。

门按其 selector 实际读取的字段识别，不依赖压缩名或 hook 序号；无法唯一识别时保留原生限制，并在 Agent 控件悬停提示中说明。升级后的诊断步骤见 [Desktop 更新兼容性诊断手册](../operations/codex-desktop-upgrade-diagnosis-playbook.md#检查-codex-额度门)。

## 其他 Harness 的只读账号额度

统一列表中展示 Grok Build、agy（Antigravity）、Claude Code 当前原生认证可读取的真实额度。原管理列改为目标 Harness 图标；原生管理边界保留在账号信息的说明中。这不是多账号管理：不提供添加、删除、切换、设为默认或重置卡操作，也不修改 Codex 当前账号。搜索和已用/剩余切换作用于所有行，刷新按钮重新查询两类额度。各 Harness 独立并行查询，任一有效结果返回后立即显示，不等待其他 Harness；全局刷新期间同样逐项恢复。

- 仅在返回有效额度窗口时显示账号。API Key、第三方 Provider、未登录、无可用数据或查询失败时不显示占位行。Host 按 Harness 缓存完成的账号检查结果 15 秒，关闭后立即重开设置页可复用该短期结果；工具栏「刷新额度」显式绕过缓存，刷新后不复用上一份账号额度，避免退出或改变认证后展示旧账号。
- 左侧展示各 Harness/供应商的产品 Logo；主标题优先显示邮箱或可识别名称，Harness 名称和套餐作为次级信息。没有账号身份时以 Harness 名称为主标题，不重复名称或显示「当前登录账号」，不会猜测邮箱。邮箱按列宽省略，悬停可查看完整身份。不记录或展示账号快照更新时间；原型中的示例套餐不作为真实数据来源。
- Grok Build 复用原生 xAI OAuth 认证和 billing 查询，展示周期、重置时间及产品用量；不将其他 issuer 的 Token 发到 xAI。套餐使用比例优先读取 `creditUsagePercent`；省略时按原生规则使用旧版套餐额度 `monthlyLimit` / `used`，没有正数套餐上限但有可识别的周/月周期及有效重置时间时，按原生零用量语义展示已用 0% / 剩余 100%，保留账号行。请求失败、空配置或异常用量字段不补成 0%；不使用 `onDemandCap` / `onDemandUsed` 的按需消费金额替代套餐比例。显式配置 `XAI_API_KEY`、`GROK_API_KEY` 或 `GROK_TOKEN` 时保守地不展示保存的 OAuth 账号。此页展示 Harness 账号额度，不判定某个 Thread 的逐模型凭据或实际 Billing Source。
- agy 执行原生 `--print=/usage --output-format stream-json`，由 CLI 自己解析认证，展示实际模型组与窗口。当前该输出不提供账号邮箱或套餐，以 Harness 名称为主标题。
- Claude Code 使用 Agent SDK 0.3.220 的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` 主动查询，并通过 `accountInfo()` 读取身份。仅投影 `rate_limits_available` 为真且有效的套餐窗口，包括原生返回的模型独立窗口；不将 session Token、会话花费或额外用量金额混为额度百分比。当前不展示 `extra_usage` 金额。旧 SDK/CLI 不支持该实验性操作时不展示。
- 查询不需要已有 Thread，不发起 Model Turn；Claude SDK 检查使用空输入流、无工具且不持久化 Session，并在成功、失败、超时后关闭检查进程。Broker 路径转发同一个只读能力。

公共数据链路是 `HarnessAdapter.inspectAccount()` → `codexhost/harness/accounts/sources` / `codexhost/harness/accounts/inspect` → 设置页；旧 Host 仍可回退到聚合的 `codexhost/harness/accounts/list`。渐进式与聚合路由共享同一份按 Harness 的 15 秒缓存和在途请求。账号快照只有可展示身份、套餐与额度，无凭据、原生路径或原始 SDK 对象；Host 不直接依赖具体 Adapter。仅查询当前 Host 已加载插件，单插件失败或超时不会阻断其他账号的返回与展示。

## 手动导入到 Pi

- 仅 Codex 与 Grok 行在「用于 Harness」列显示 16px 的 Pi 小图标，其他账号（如 Claude Code）不渲染任何入口。未复制时为弱化单色，已复制时为常规强度并带小圆点（配置已变更为警示色），悬停显示入口名与状态。点击未复制的图标，在单个确认对话框里查看来源、模型入口名称、新增范围与风险；未确认不写入，成功后在同一对话框提示一次“新开的 Pi 会话即可选用，无需重启；已打开的会话没看到时重新打开即可”。点击已复制的图标会定位到下方对应记录。默认入口名让人能看出账号：某个 Provider 的第一个账号用 `codex` / `grok`，之后的账号用 `codex-<邮箱前缀>`（如 `codex-alice/…`），仍冲突或没有邮箱时用 `codex2`、`codex3`…；Pi 里同一 Provider 可以并存任意多个账号，各占一个入口。名称须为 1–48 位小写字母、数字或连字符，以字母开头。
- 只支持经过字段/客户端校验的 Codex 文件型 ChatGPT OAuth 和 Grok xAI OAuth。API Key、钥匙串型 Codex 登录及 Claude Code 等来源暂不导入；不兼容或目标不可用时不显示图标。来源账号改变后提交旧来源标识会被拒绝，必须重新刷新并确认。
- Pi Adapter 在所配置 Pi 的用户目录（支持 `PI_CODING_AGENT_DIR`）写入独立 `auth.json` 条目和 `extensions/codexhost-account-<name>/` 扩展、非敏感导入记录。通过安装的 Pi 原生认证存储锁协调写入，复用该安装的 OAuth 刷新和模型传输实现。不覆盖内置名称、已有凭证、模型配置或本功能创建的同名入口；名称冲突应换名；导入前通过 Pi 离线模型目录检查已启用扩展注册的可用入口。外部扩展未来也可能注册名称，用户应选择未占用的新名称。
- 当前要求 npm 安装且暴露原生 Provider/AuthStorage 模块的 Pi。生成的扩展引用检测到的安装路径；迁移或删除该 Pi 安装后需修复/重新导入。不安装依赖、不登录、不刷新 token，也不进行收费模型探测。
- 下方「Pi 中的账号」专区仅在 Pi 可作为目标时出现，与账号表使用同一种卡片：每条记录展示来源账号（沿用来源标记）、来源 Agent、Pi 中的入口 `name/…`、“已复制”和复制时间（不显示“已验证/未验证”，因为目前没有任何来源可判定调用是否成功），行内提供「重新导入」「移除」。来源账号不是当前原生登录（换了账号、退出或改用 API）时，记录照常保留，不显示任何警告或提示，只是不再提供「重新导入」，仍可「移除」。没有记录时显示引导文案。不重复展示额度，已有 Pi 配置不自动认领；用户在 Pi 中改写或删除某条导入凭据后，该记录不再属于本功能：它直接从列表中消失，不显示任何状态文案；凭据若仍在则按普通 Pi 登录展示。本功能不会自动删除遗留的扩展目录，也不在界面上提示，交由 Pi 原生管理。元数据读取失败的条目同样跳过，不影响其余记录。
- Pi 不可用时整个专区不出现，上方账号行也不显示 Pi 图标：未安装、非 npm 安装、缺少订阅导入所需的原生模块，或从未运行过（没有 Pi 用户目录）都算不可用，不显示占位或错误提示。
- 专区标题是「Pi 中的账号」，一张列表列出 Pi 的 `auth.json` 里的全部登录：codexhost 导入的记录排在前面（有「重新导入」「移除」）；Pi 原有的登录收在下方的「Pi 自有配置 N」折叠条里，**默认收起**，展开后只读显示，无任何按钮。OAuth 条目按其访问令牌自身的签发方与 client id 识别供应商（与 Codex/Grok 导出校验的是同一对常量），识别出的条目显示与上方账号表一致的供应商 Logo，与用户给 Pi 入口起的名字无关；同一签发方的其他应用、API Key 及无法识别的条目保留中性 Pi 标记，不猜测供应商。折叠状态只存在于当前页面，重新打开设置页恢复收起。没有 Pi 原有登录时不显示折叠条。Pi 原有登录显示账号标签和「Provider · 类型（OAuth / API Key / 其他）」；账号标签只在能从 OAuth 访问令牌里本地解出邮箱时才有，否则以 Provider 名作标题。另外读取 `models.json`：其中自带 `apiKey` 的自定义 Provider 也一并列出（类型记为 API Key，`name` 与 Provider 名不同时作为标签），仅在 `models.json` 配置而凭证仍在 `auth.json` 的按 Provider 名合并，不重复成两行。不显示凭证值或过期时间，不联网、不查额度。环境变量和扩展自行管理的登录不在其中。Pi 中完全没有登录时才显示引导文案。
- 从 Pi 移除前再次确认，仅移除本功能拥有的 Provider 扩展、凭证条目和记录，保留其他配置及用户追加的文件，不退出来源账号、不撤销服务端授权。新建 Pi 会话会启动新的 Pi 进程并读取最新配置，无需重启 codexhost；已打开的会话持有自己的进程，可能仍保留旧配置。
- 复制不是持续同步，也不增加额度。两端自行刷新同一 refresh token 可能互相影响登录；实际 Billing Source 遵循 Provider 规则。“已复制”不表示凭证或模型仍然可调用。“重新导入凭证”也需确认，仅允许同一来源账号更新本功能仍然拥有的入口；来源不是当前登录时不提供。换账号无需移除旧入口，直接为新账号新增一个入口即可，旧账号的入口继续保留。
- 浏览器契约仅包含来源标识、标签、Provider 类型、导入状态，以及其他登录的 Provider 名称、类型、可选的账号标签与识别出的供应商。源 Adapter 的 `credentialExport` 与目标 Adapter 的 `credentialImports` 只在后端交换授权；Codex 原生来源由 Host 的 Codex 模块提供。`codexhost/harness/credential-imports` 不接收 token 或路径，异常不转发 SDK 原始信息。没有跨 Host/SSH 的凭证搬运。

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
- `packages/renderer-extension/src/settings/accounts-page.ts`：身份、额度与手动导入入口。
- `packages/renderer-extension/src/settings/credential-imports.ts`：Pi 小图标、确认对话框与「Pi 中的账号」专区。
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
