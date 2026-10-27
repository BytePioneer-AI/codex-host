# 本地固定聊天定时任务

Desktop 内的 codexhost 设置提供“定时任务”页和新建入口。用户显式选择本地 Harness 和 Model，填写任务正文、每天或每周的本地时间。高级设置中的工作目录可以留空，Desktop 按自己的配置根目录、日期和名称分配持久工作区；指定目录必须能由本地 app-server 读取。页面不修改普通聊天的 Harness 偏好或官方默认 Model。

每个日程创建一个固定的外部 Thread。原生 `startConversation` 用空输入建立聊天及模式、权限状态；创建阶段不执行任务正文，也不发送 setup Turn。确认 Host 返回的 Harness/Model 和 Desktop 聊天就绪状态后，`localAutomations.create` 保存 `kind: heartbeat`、目标 Thread、正文、活动状态和 RRULE。日程中的 Model 与 reasoningEffort 为原生 heartbeat 要求的 `null`，不复制 Thread 的配置。执行仍由 Desktop 读取并恢复同一 Thread；Harness、工作目录及有效 Model 属于 Thread。

创建成功或已确认部分创建时，页面提供目标聊天入口。同页列表显示并管理经 Host 持久化 ownership 确认的本地 Codex 与外部固定聊天任务；官方任务列表读取同一份日程。列表按目标 Thread 的当前 ownership 标记 Codex 或实际 Harness，不按创建入口筛选。codexhost 不镜像日程，不提供后台调度器或数据库；没有独立 Console 入口、云端/远程执行、每次新建聊天、Worktree、通知配置、自动审批或补跑策略。忙碌、审批、提问和失败遵循 Desktop 与 Harness 的原生行为；不承诺 Desktop 关闭期间运行或精确到秒。

## 创建失败

- 创建期间禁用重复提交，同一页面内的并发提交共用一个请求。
- 分配工作区、校验目录或创建聊天未成功时，不保存日程；不回退到临时目录，不自动删除任何工作区。
- 已确认 Thread 后，明确的日程写入前拒绝允许保留配置、复用同一 Thread 重试；不创建第二个 Thread。
- 写入请求超时、断线、返回形状无法确认，或无法证明失败发生在写入之前时，显示结果未知并禁用重放。先返回列表刷新核对，必要时使用官方列表。
- 离开页面停止等待和后续步骤，不保证撤销已发出的原生操作。页面不持久化未完成流程。

## 任务列表与管理

页面进入、显式刷新和操作成功后，直接调用 `localAutomations.list`。只显示本地 heartbeat，且每条目标 Thread 必须经 `codexhost/thread/ownership/list` 确认持久化 Codex 或外部 Harness 归属；不通过打开或恢复 Session 猜测归属。cron、云端和远程任务不开放操作。个别归属或数据读取失败会显示未确认数量，保留其他已确认任务；列表服务整体失败明确报错，不显示为“暂无任务”。

列表显示名称、Harness、日程和启用/暂停状态。打开聊天通过 Desktop 原生路由进入目标本地 Thread，确认路由到达后关闭设置页，不依赖侧栏是否展开或显示目标聊天；跳转失败保留页面并提示。聊天内可查看历次执行记录，不复制消息历史。编辑复用创建表单的正文与时间控件，仅提供名称、正文和每日/每周本地时间；Harness、工作目录和目标 Thread 不可改，Model 通过聊天修改。

每次修改、暂停/恢复或删除之前重新读取当前原生日程并确认归属与目标 Thread。`update` 使用原 automation id，保留当前通知策略和未修改的字段，不新建 Thread 或日程。基础时间编辑支持单时间每日、单日每周，以及有效且不重复的全七天每周规则（显示为每日）。遵循该 Desktop 的 DAILY/WEEKLY 执行路径，省略 BYSECOND 时按 0 秒处理；显式非 0 秒、重复或非法 weekday 均不纳入基础编辑器。仅改名称或正文仍原样保留原 RRULE。部分多日、非 1 间隔、时区/起始日期、COUNT/UNTIL、多时刻或其他扩展规则不转换，仍可改名称和正文，时间提示使用官方编辑。

删除需要确认，只删除日程，保留聊天和工作区文件，不停止正在运行的 Turn。操作期间禁用重复提交，不自动重试任何已发出但结果不确定的修改或删除，包括带 numeric RPC error 的异常。结果未知时保留提示并要求显式刷新核对；进行中的写操作及其之前开始的读取不能解除重复写入防护。没有后台轮询、额外存储或跨页面持久化的事务状态。

## Desktop 私有接入边界

Renderer 复用原生服务加载器，从当前页面同源 `modulepreload` 模块的导出中按所属 registry 与必要方法发现 `localAutomations`，支持 callable RPC proxy；不依赖 chunk 哈希或压缩导出名。Renderer 仅向 `desktop-control` 传入任务所需的固定操作。原生请求返回值是可释放 thenable，调用结束后释放其 RPC 引用。

管理要求唯一匹配的 local Host manager、原生 scope/queryClient 以及 list/update/delete。创建另外要求主窗口 heartbeat 观察器、已安装的 scoped empty-chat/prewarm 绑定、默认工作区分配、原生创建输入 reader 和 `localAutomations.create`。缺少创建能力只禁用新建并显示具体原因，已可用的列表和管理继续工作。连接替换、归属作用域缺失或歧义均关闭对应操作；不写 automation.toml/SQLite，也不启用其他定时器。

创建输入 reader 没有语义导出名。当前适配按 Desktop 26.1021 工厂的窄源码结构识别：它接受 scope/host，构造原生 reader 和 dynamic-tool dispatcher。只接受唯一候选，调用后核对 reader 的方法，以及 scope、local Host 和 requestClient 对象身份；不在发现阶段调用候选函数。此工厂源码结构仍是私有版本依赖，结构变化或归属不能确认时禁用新建。工作区分配直接复用 manager，不再重复绑定工作区 RPC；manager 归属复用 Host routing/registry。

空输入原生创建后，只接受 manager 中已注册、resumed、带有效 collaboration mode/权限且无 Turn、无待处理请求的空聊天。此检查限于本页新建的空聊天，后续 eligibility 和权限变化仍由 Desktop 原生 heartbeat 观察器维护，不维护另一份状态。

原生预热池按 cwd 共享。普通创建按本次 Model 检查消费结果，官方入口不能消费外部预热；显式任务创建跳过普通草稿预热。不匹配的预热结果不参与本次创建，清理失败不会阻止新聊天创建。普通外部草稿只使用身份绑定的原生草稿设置，且不保存为官方默认值。细节见[官方流量归属](../architecture/official-traffic-ownership.md)。

创建后刷新官方任务列表查询，由 Desktop 的既有后台观察器维护 heartbeat 模式及就绪状态；页面不手工发送 eligibility 消息或维护另一套模式/权限状态。

## 验证状态

受控测试覆盖请求隔离、并发预热消费、显式任务不消费普通草稿、服务形状与不可用条件、默认/指定目录、空输入创建、就绪检查、部分失败、重复提交、超时及页面取消。管理测试覆盖混合 Codex/外部归属、局部或不一致 ownership、保留当前字段与复杂 RRULE、原 id 更新、暂停/恢复、仅删除日程、未知结果与过期读取防护；浏览器 fixture 覆盖 Codex 历史聊天入口及管理期间不发起外部创建、外部任务管理、重进与过期结果，以及中文窄屏/深浅色混合列表布局。这些不是 Desktop 到期执行验收。

本机 Desktop 26.1021.31345 的只读核对确认：原生 `localAutomations` 与 `projectlessThreads` 均为函数型 RPC proxy；原先只接受对象的组合 guard 会误拒绝它们。主窗口及另一有 local manager 的 Renderer 均能只读列出 3 条 ACTIVE heartbeat；后者不具有主窗口观察器。原生创建输入 reader 的 scope/Host/requestClient 身份已只读确认。服务发现与创建绑定的 fixture 不能代替实际创建或到期执行。

当前源码改动尚未在真实 Desktop 完成 Pi 与第二个 Harness 的到期执行、离页后执行、连续复用、Model 修改、重启恢复，以及官方列表与自有页面真实数据互通、任务管理和忙碌/审批验收。运行中的 Desktop 用于主会话审查，未停止、重启或替换其运行时；没有创建或修改用户日程。上述真实验收完成前，不宣称该版本的定时执行已验证可用。

普通草稿实际发送的 native Model carrier、精确的 draft→setter 关联及共享预热隔离也未做 live 验证。只读观察到 Composer Fiber 缓存中的 scope/atom 形状、scope.value 的 `clientThreadId` 字段，以及 ThreadCreation 实例自身键只有 `params`、构造器源码未检出私有字段；草稿 setter 与当前账号设置模式的关联已用安装包原生 Hook 做隔离验证；浏览器 fixture 覆盖空草稿在两种账号设置模式下，经 Send、Model 解析、Thread 创建到首条 Turn 的请求链路，以及同目录官方任务、外部定时任务与普通草稿的预热隔离。ThreadCreation 内部参数和调用链、每次调用视图及预热隔离的行为依据仍是安装包 bundle 分析与受控 fixture。OpenSpec 中实现与 fixture 任务的勾选不表示功能验收通过；真实调度与管理验收仍单独跟踪。
