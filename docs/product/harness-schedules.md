# 本地固定聊天定时任务

## 入口与任务管理

Desktop 内的 codexhost 设置侧栏保留“定时任务”入口，选择后直接进入官方任务页面，不显示自有任务列表或创建、编辑表单。跳转通过 Desktop 原生 `navigate-to-route` 路由发送 `/automations`；Desktop 26.1023.50603 在启用新版任务 UI 时将它重定向为 `/scheduled`。只确认当前活动页面的 committed LocationContext，不把后台保留的标签页当作到达。到达后关闭 codexhost 设置；失败或超时保留错误提示和显式重试，不自动重放导航。离开设置目标会停止等待。

任务创建、查看、修改、暂停、恢复和删除均在官方 UI 中完成。此入口不读取或写入任务存储，不迁移或删除已有日程、Thread 和工作区。没有独立 Console 入口。

### 侧栏会话图标

官方定时任务侧栏中的本地固定聊天条目，通过原生 `automation.targetThreadId` 关联目标 Thread，复用普通会话列表的按 Host 批量归属查询、缓存及插件图标。标题左侧显示实际 Harness 图标；已确认的 Codex 会话在任务侧栏和普通会话列表中均显示 Codex 图标。不根据任务名称、提示词或当前 Composer 的选择猜测 Harness，也不打开会话或启动 Harness 来确定归属。未知归属、绑定缺失、云端任务及没有固定目标 Thread 的任务不添加图标。

绑定依据 Desktop 26.1023 的侧栏条目语义属性、任务容器及 committed React props；图标定位在 `aria-labelledby` 对应的标题行，保留时间副标题和原生菜单。条目复用、标题替换与卸载时更新或清理装饰，不修改原生日程。

## 官方新建弹窗

官方“设置定时任务”弹窗提供独立的 Harness / Model 选择，初始为 Codex，不继承普通聊天的 Harness 偏好。选择 Codex 时不改原生草稿；外部 Harness 列表只读取当前本地连接缓存中已确认 `ready` 的插件，排除检查中、不可用和 usage 插件；不为打开弹窗重新列举或批量探测 Harness，也不新增一套可用性缓存。连接身份变化时不复用旧列表，可用性通知同步更新选项。已选 Harness 从缓存消失时阻止提交，不自动切回 Codex。缓存为空时仍提供原生 Codex 入口。

用户选择后才读取该 Harness 的模型目录，只通过该弹窗的原生 `onChange` 更新任务草稿的 transport Model。切回 Codex 恢复捕获的原生 Model / reasoningEffort；原生状态尚未确认时阻止提交，避免选择与实际请求不一致。Harness 与模型使用与官方设置行一致的纵向行，值为带下拉箭头的选择器：Harness 当前值及菜单项使用插件 Logo（复用 Renderer Agent 图标），菜单为本弹窗专用的 listbox，支持方向键、Home/End、Enter、Escape（只关闭菜单，不关闭弹窗）与外部点击关闭。已选 Harness 从缓存消失时仍显示其名称并阻止提交。模型目录加载显示固定高度的占位文案与忙碌指示，不显示空下拉框；加载与确认成功后不保留说明文字。模型写入后短暂核对 committed props，即使原生提交没有产生 DOM 变化也会更新确认状态；等待期间不显示错误，确认超时或加载失败提供显式重试，不自动重写模型或重放任务提交。

外部 Harness 仅支持个人、本地、固定聊天任务。在原生高级设置中启用“在此电脑上运行”并关闭“每次运行都开启新聊天”后可选择。云端、团队、Goal 和 cron 新聊天模式不开放外部选择；外部选择后若原生表单切到不支持的模式，则阻止提交并提示，不静默改用 Codex。外部选择时隐藏原生 Codex Model / Effort 两行，Model 使用 Harness 目录；不映射 Codex 强度控件为 Harness Thinking。创建中的任务及已得到目标 Thread 的任务不允许更换 Harness / Model。

时间、通知、任务内容、校验、重复提交防护、工作区分配、创建聊天、日程保存、列表刷新及跳转均由官方流程处理。扩展不调用或替换原生提交回调，不直接写日程，也不重放提交。官方流程在日程保存后会向新聊天发送 `scheduled_task_setup` 消息，并附带只确认任务设置的原生指令；这是实际 Harness Turn，不保证不会调用工具。扩展不额外执行任务正文或替换原生指令。

### 工作目录

官方新建固定聊天任务走无项目聊天创建，工作区由 Desktop 自动分配，此弹窗没有任意目录输入。官方“每次运行都开启新聊天”的本地 cron 模式提供已有本地项目选择，而非任意路径输入；外部 Harness 选择不开放该模式。codexhost 不额外提供指定目录的任务创建表单。

## 执行与接入边界

日程保存在官方 `localAutomations` 中。固定聊天任务执行时由 Desktop 读取并恢复同一 Thread；Harness、工作目录及有效 Model 属于 Thread。官方列表中已有外部任务仍按原 Thread 的持久化 Harness 归属执行。codexhost 不镜像日程，不提供后台调度器或数据库，不写 automation.toml/SQLite，也不启用其他定时器。忙碌、审批、提问和失败遵循 Desktop 与 Harness 的原生行为；不承诺 Desktop 关闭期间运行或精确到秒。

表单绑定依据 Desktop 26.1023.50603 的配置表单语义 props：`setup.triggerMode: create`、无日程 id 的草稿、原生 `onChange` / `onSubmit` 和执行位置。使用 committed React tree，不绑定 chunk 名、压缩函数名、翻译文本或 Hook 下标。已有任务编辑不挂载选择器。Model 目录过期结果、连接替换、绑定缺失、Model 未确认均阻止对应外部提交；Codex 路径不依赖 Harness 目录可用。表单关闭后释放选择和监听，不修改全局偏好。

官方表单入口依赖现有草稿作用域路由与预热隔离，不能恢复为用 Host 最后一次选择覆盖所有 `thread/start`。原生预热池按 cwd 共享；普通聊天与任务创建均按本次 Model 检查消费结果，Codex 创建不能消费外部预热，外部创建只能消费与本次 transport Model 一致的预热。不匹配的预热结果不参与本次创建，清理失败不会阻止新聊天创建。普通外部草稿只使用身份绑定的原生草稿设置，且不保存为官方默认值。细节见[官方流量归属](../architecture/official-traffic-ownership.md)。

## 验证范围

官方弹窗接入已核对 Desktop 26.1023.50603 安装包中的表单、草稿 Model 默认补齐、显式 Model 创建空聊天、heartbeat 保存和 setup 消息调用链。绑定单测与浏览器 fixture 覆盖 Codex 透传、外部显式选择、原生日程/通知保留、切回 Codex 的异步恢复、目录竞争、关闭重开、绑定/路由/连接失效、非支持模式、已有编辑不挂载及窄屏深浅色。导航 fixture 覆盖设置入口直达、原生重定向、history/memory 路由、后台标签不误确认、失败重试与离页取消；它们不替代真实 Desktop 验收。

真实 Desktop 的入口跳转、表单创建、Pi 与第二个 Harness 的到期执行、离页后执行、连续复用、Model 修改、重启恢复，以及忙碌/审批行为仍需单独验收。普通草稿的 Model carrier、draft→setter 关联和共享预热隔离也仍需 live 验证；安装包分析和受控 fixture 不能证明真实调度可用。
