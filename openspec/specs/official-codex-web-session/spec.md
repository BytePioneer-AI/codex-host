# official-codex-web-session Specification

## Purpose

定义 Web 如何通过共享 Host 新建和操作官方 Codex Thread，使 Web 与 Desktop 共用同一批会话，不再经过独立的 Codex Harness 接入。

## Requirements

### Requirement: 单一 Codex 入口
Web 选择器 SHALL 只提供一个 Codex 入口。官方 Codex 可用时显示该入口，新建的会话 MUST 是官方 Codex Thread。官方 Codex 不可用时 MUST 不显示该入口，其他 Harness 不受影响。

#### Scenario: 官方 Codex 可用
- **WHEN** Host 找到可运行的官方 Codex 程序
- **THEN** Web 选择器显示一个“Codex”，且不显示“Codex CLI”

#### Scenario: 新建官方 Thread
- **WHEN** 用户选择 Codex 并发送第一条消息
- **THEN** Host 创建官方 Codex Thread，Web 列表以官方 Thread ID 显示一条记录，Desktop 也能看到该 Thread

#### Scenario: 无项目新建
- **WHEN** 用户未选择项目并发送第一条消息
- **THEN** Host 分配默认生成目录并以此创建官方 Thread，Web 不自行分配目录

#### Scenario: 官方 Codex 不可用
- **WHEN** Host 既找不到 Desktop 自带程序，也找不到符合版本要求的本机 `codex`
- **THEN** Web 不显示 Codex 入口，其他 Harness 正常显示

### Requirement: 官方程序来源
Host SHALL 优先使用 Desktop 自带的官方 Codex 程序，其次使用本机安装且版本不低于 0.161.0 的 `codex`。Host MUST 拒绝 codexhost shim 或代理程序。

#### Scenario: 已安装 Desktop
- **WHEN** Desktop 自带程序和本机 `codex` 同时存在
- **THEN** Host 使用 Desktop 自带程序

#### Scenario: 只有本机 codex
- **WHEN** 未安装 Desktop，且本机 `codex` 版本符合要求
- **THEN** Web 可通过该程序新建和续聊官方 Codex Thread

#### Scenario: 找到的是 shim
- **WHEN** 发现结果指向 codexhost shim 或代理
- **THEN** Host 将其视为不可用，不启动它

### Requirement: 官方后台启动参数一致
Web 先于 Desktop 启动官方后台时，Host SHALL 使用最近一次记录的 Desktop 启动参数；没有记录时使用基线参数。Desktop 接入时参数不同且后台没有活动工作，Host SHALL 替换一次后台；有活动工作时 MUST 保留现有后台。

#### Scenario: 有历史参数
- **WHEN** Desktop 曾连接过，之后 Web 先启动官方后台
- **THEN** 后台使用记录的 Desktop 参数

#### Scenario: 首次由 Web 启动后 Desktop 接入
- **WHEN** 后台以基线参数运行且空闲时，Desktop 带不同参数接入
- **THEN** Host 用 Desktop 参数替换后台，Desktop 正常连接

#### Scenario: 存在活动工作
- **WHEN** 后台存在进行中的 Turn，Desktop 带不同参数接入
- **THEN** Host 不中断该 Turn，保留现有后台并记录诊断

### Requirement: Web 操作官方 Codex Thread 的能力
Web SHALL 对官方 Codex Thread 提供模型、Thinking、权限、排队消息、`/compact`、`/review`、Skill 菜单、同目录 Fork、置顶和会话用量。配置 MUST 以官方目录和官方确认结果为准，未确认时不得显示为已生效。

#### Scenario: 切换模型
- **WHEN** 用户在官方 Thread 中切换模型或 Thinking
- **THEN** Web 仅在官方确认后显示新值，后续 Turn 使用该配置

#### Scenario: Fast 服务档位
- **WHEN** 官方 Model 目录声明当前 Model 支持 `priority` 服务档位
- **THEN** Web 显示 Fast 闪电，开启和关闭分别使用同一原生 Model 的 `serviceTier: "priority"` 与 `serviceTier: null`，保留 Thinking，且仅在官方确认匹配档位后显示生效
- **AND** 创建、恢复和 Desktop 设置变化以官方返回的档位显示状态；后续 Turn 沿用官方设置
- **AND** 没有 `priority` 元数据时不显示闪电，不根据 Model 名或旧速度标签猜测支持

#### Scenario: 切换权限
- **WHEN** 用户打开官方 Thread 的权限选择
- **THEN** 选项来自官方权限档案列表，选择结果由官方确认

#### Scenario: Turn 运行中发送
- **WHEN** 官方 Thread 正在运行，用户选择排队发送
- **THEN** 消息进入官方队列，Web 可编辑、删除和立即发送，Desktop 能看到同一队列

#### Scenario: 执行命令
- **WHEN** 用户在官方 Thread 中执行 `/compact` 或 `/review`
- **THEN** 命令由官方 Codex 执行，Web 显示执行结果

#### Scenario: 置顶和用量
- **WHEN** 用户置顶官方 Thread 或查看其用量
- **THEN** 操作成功，结果与 Desktop 一致

#### Scenario: 分叉官方 Thread
- **WHEN** 用户从侧栏或已结束轮次分叉官方 Thread
- **THEN** 官方 Codex 创建同目录的独立 Thread，精确保留选定轮次及之前的历史，来源 Thread 保持不变
- **AND** 派生 Thread 与 Desktop 共用官方身份，生效配置以原生返回为准，不写入来源 Thread 的配置

#### Scenario: 分叉结果未知
- **WHEN** 官方 Fork 的响应断开或未确认独立 Thread ID
- **THEN** Web 显示未确认原因，不自动重试、不重发历史消息，也不降级为外部 Harness 创建

### Requirement: 官方服务端请求不悬挂
Web SHALL 回答审批、非密码提问和表单式询问。对 Web 不能回答的请求，没有 Desktop 连接时 Host MUST 立即返回错误并在会话中提示；有 Desktop 连接时 MUST 不回答，交由 Desktop 处理。

#### Scenario: Desktop 不在线
- **WHEN** 没有 Desktop 连接时，官方 Codex 发出权限授予、密码输入或动态工具调用请求
- **THEN** Host 立即返回错误，Web 显示原因，Turn 不会一直等待

#### Scenario: Desktop 在线
- **WHEN** Desktop 已连接，官方 Codex 发出 Web 不能回答的请求
- **THEN** Host 不抢先回错，请求由 Desktop 处理

### Requirement: 官方写入占用
官方 Thread 被其他 Codex 后台占用时，Web SHALL 仍能显示其历史，发送 MUST 返回官方占用错误并提示用户先在另一端关闭该会话。Host MUST 不绕过官方写入限制，也不得自动 Fork。

#### Scenario: 打开被占用的会话
- **WHEN** 会话正被直接打开的 ChatGPT.app 或 VS Code 插件占用
- **THEN** Web 显示历史，并标明当前不能发送

#### Scenario: 占用已释放
- **WHEN** 另一端释放会话后用户再次发送
- **THEN** 消息正常发送到同一 Thread

### Requirement: Web 与 Desktop 共用官方 Thread
通过 codexhost 打开的 Desktop 与 Web SHALL 操作同一批官方 Codex Thread，一端的消息、状态和审批结果 MUST 在另一端更新。同一 Codex 数据目录下的官方 Thread MUST 无需导入即可在 Web 显示。

#### Scenario: 两端同时打开
- **WHEN** 同一 Thread 在 Web 和 Desktop 同时打开，一端发送消息
- **THEN** 另一端显示新消息和运行状态

#### Scenario: Desktop 窗口关闭
- **WHEN** Desktop 窗口未打开，用户在 Web 打开官方 Thread
- **THEN** Web 可显示历史并续聊

#### Scenario: 归档后撤销
- **WHEN** 用户归档官方 Thread，撤销归档后继续发送
- **THEN** 消息正常发送

### Requirement: 不再提供 Codex CLI 接入
Host SHALL 不再提供 `codex-cli` Harness 及其专用会话导入，其他 Harness 的通用导入 MUST 不受影响。

#### Scenario: 其他 Harness 导入
- **WHEN** 用户导入 Pi 或 Claude Code 的原生会话
- **THEN** 导入行为不变
