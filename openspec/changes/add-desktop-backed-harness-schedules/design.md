# Design

## Context

范围见 [proposal.md](proposal.md)。此变更涉及跨包接入与官方流量归属，因此保留设计文档。

已核对的实现依据：

- `desktop-control/src/renderer-draft-prewarm-runtime.ts` 在 Host 请求桥中保存 `selectedModel`，覆盖非临时 `thread/start`；`renderer-extension/src/versioned-renderer-adapter.ts` 从 Composer 调用该选择，作用域因此大于实际草稿。
- `renderer-extension/src/renderer-binding-probe.ts` 从本地偏好恢复新聊天 Harness；这项普通聊天行为保留，不能以清空用户偏好代替隔离。
- 本机 Desktop 26.1021.31345 的官方页面调用内部 `localAutomations` 服务。heartbeat 保存 `targetThreadId`、任务正文及日程，触发时读/恢复目标 Thread，再发起 Turn；它不接受 Harness，也不独立保存 Model 和工作目录。
- Desktop 的无项目工作区分配服务遵循配置的根目录，默认根目录为 `~/Documents/Codex`，按日期及聊天名称分配独立目录。外部 `thread/start` 当前要求非空 `cwd`。
- 已有 Pi Thread 完成过 Desktop heartbeat 消息；这证明该执行路径可行，但未证明所有 Harness、重启恢复或精确触发时间均已通过验收。当前调度器还依赖 Desktop 维护的目标聊天模式与就绪状态。
- 现有设置页有页面注册、作用域取消及模型客户端；独立 Console 复用部分页面，但不等同于具备 Desktop 内部任务服务。

## Decisions

### 1. 只增加一个 Desktop 内任务页

在现有 `settings/pages.ts` 注册自有“定时任务”页，按现有 Shadow DOM、Tailwind 与页面作用域实现。创建字段仅为任务内容、Harness、Model、每日/每周及时间；工作目录放在高级设置。名称可从正文生成，时间按当前 Desktop 本地时区表达。页面提供任务列表、新建入口和目标聊天入口；编辑复用创建页已有的正文与日程控件。

Harness、Model 复用本地插件目录和模型目录，页面显示明确的选择，不读取普通 Composer 的最后一次选择来决定任务归属。不新增权限策略、Thinking、自定义 RRULE 编辑器、通知设置或模板系统；已有聊天控制保留其原生行为。不新增 Console 桥接或独立管理后台。

### 2. 固定能力接入 Desktop，保持包所有权

`desktop-control` 拥有版本化内部服务发现、默认工作区分配和任务创建绑定；向页面提供范围固定的能力，不暴露任意 Desktop RPC 或脚本执行接口。浏览器安全的输入/结果类型放在 `shared-contracts`；页面不得导入 Electron、Node 或 Harness SDK。

Thread 的 Harness、Model 和 `cwd` 仍由 Host 的现有创建及持久化路径负责，复用现有 transport Model 编码、模型目录和 ownership 查询。只有现有公共操作不足时才增加窄的创建组合接口；不复用会立即发出任务正文的委派命令，不新增 Adapter 方法或 Harness 专用调度分支。新绑定放在聚焦模块中，不继续堆叠大型路由模块。

### 3. 创建顺序与就绪

1. 检查本地 Desktop 的任务、聊天创建及默认工作区接入；校验本次 Harness/Model 和日程。
2. 显式目录直接验证使用；留空时调用 Desktop 的默认工作区分配服务，不能手写一套目录命名或临时目录回退。
3. 用本次显式配置创建外部 Thread，并通过 Desktop 既有聊天接入建立必要的本地 Thread、模型和权限状态。不能仅取得 Host Thread ID 就假定可被调度；创建阶段不执行任务正文。
4. 通过 `localAutomations.create` 保存 `kind: heartbeat`、目标 Thread、正文、周期和活动状态；Model 与 `cwd` 不塞入日程接口。确认成功后展示结果。

后续创建页可卸载；执行依赖 Desktop 的调度器和 Thread 生命周期，不依赖页面定时器。Model 后续跟随目标聊天的有效配置，Harness 和目录保持该 Thread 的既有归属。只承诺本地 Desktop 运行期间的原生调度语义。

### 4. 请求作用域隔离

外部路由必须从可确认的草稿/创建操作取得配置，不能对 Host 上全部 `thread/start` 覆盖 `model`。官方任务创建不带外部创建上下文，保留原生 Codex 请求；自有页面的外部创建显式携带自己的配置，不能先设置全局 Pi、发请求、再切回 Codex。

实现时沿用现有版本化桥的生命周期和草稿预热控制，绑定到真实创建操作；不得用 URL、任务文案或单一“当前页面”布尔值猜测请求归属。缺少可验证关联时阻止对应外部创建，官方请求保持透传。新增规格是既有 Composer 隔离契约的补充，旧测试中不带来源地将所有新建请求改写为 Pi 的断言需要收窄。

已有外部 Thread 仍按持久化 ownership 处理。官方列表可以显示和管理自有页面创建的任务；不改造官方列表、不迁移已有任务，也不将外部 Thread 重写为 Codex。

### 5. 只处理创建流程必要的失败

创建期间禁用重复提交。分配目录或创建 Thread 失败则不保存日程；Thread 已创建但日程明确失败时保留 Thread 入口及当前页面内的引用，允许复用它重试。结果不确定时提示在官方列表核对，不自动重放写请求。

不增加持久化工作流、补偿队列或日程镜像，不自动删除生成的目录或可能已绑定的 Thread。页面卸载使用现有取消/过期结果处理；说明取消等待不保证撤销已提交的服务端操作。

### 6. 最小任务列表与管理

复用 `localAutomations.list/update/delete`，展示本地 `heartbeat`，通过现有 Host ownership 查询区分官方 Codex 与外部 Harness，并在同一列表中标明归属。不按创建入口、任务标题或内存中的创建记录过滤；无需新增“由本页面创建”的持久化标签。已确认的两类固定聊天日程均可管理；cron、云端和远程任务继续不开放写操作。无法确认归属时显示局部读取失败提示，不能把查询失败当成 Codex。

列表只显示名称、Harness、日程和活动/暂停状态，提供打开聊天、修改、暂停/恢复及删除；官方条目标为 Codex。Codex 与外部任务共用这些操作，不增加两套列表或管理分支框架。历史通过既有聊天入口查看，不做第二份消息列表或运行记录面板。重新进入页面及操作成功后重读 Desktop；提供手动刷新，不新增后台轮询器。新建表单仍仅创建外部 Harness 任务，官方 Codex 创建入口保持原生。

修改仅更新名称、正文和每日/每周时间，不重新创建 Thread 或日程。每次写入前读取目标日程当前值并确认归属，按官方完整参数要求保留未修改字段（例如通知策略），不将页面默认值覆盖到既有配置。超出基础编辑器能力的原生日程保留原值，允许仅改正文/名称，不静默转换其重复规则。Harness、工作目录和目标 Thread 不可在日程编辑中更换；Model 通过聊天入口调整。

暂停/恢复使用原生日程状态；删除先确认，明确只移除未来调度，保留聊天和文件、不停止正在执行的 Turn。列表读写复用当前页面生命周期和操作进行中防护；写结果未知时不自动重放，通过重新读取确认。无需任务仓库、事务队列、通用 CRUD 框架或额外调度状态机。

## Risks / Trade-offs

- [Desktop 内部接口随版本变化] → 接入前验证接口与目标 Host，缺失时禁用创建；不直接修改 automation.toml、SQLite 或改用 launchd/cron。
- [存在 Thread 但调度模式状态未准备好] → fixture 验证就绪约束，并在真实 Desktop 验收离开页面、后台触发及重启恢复；未完成验收不得宣称支持。
- [不同 Harness 的恢复、模型或交互差异] → 使用现有 Adapter 语义，不新增“定时能力”标志或全 Harness 强制认证矩阵；真实验证 Pi 及一个现有可用的其他 Harness，明确记录未验证组合，真实不可用时不给出成功承诺。
- [任务需要审批或目标聊天忙碌] → 原样呈现既有等待/失败行为，不绕过审批或增加并行、重试、补跑策略。界面不承诺精确到秒或 Desktop 关闭后继续运行。

## Migration

不迁移已有 Thread 或任务，不新增独立日程存储。新创建页与官方路由隔离可分别禁用；关闭自有创建页不会删除已保存日程，用户继续通过官方界面管理。回滚时须说明已有外部任务仍依赖其 Host/Adapter 和 Desktop 的可用性，不能悄悄将其转换为 Codex。
