# harness-command-capabilities Specification

## Purpose

Define the small, explicit contract for Harness-specific commands exposed through codexhost.

## Requirements

### Requirement: Commands are explicitly registered by the owning Adapter

A Harness Adapter MUST publish a command catalog containing stable command IDs, invocations, labels, and argument modes. A command MUST NOT be available merely because a native Harness accepts an arbitrary command string.

#### Scenario: Pi exposes compact

- **WHEN** the Pi Adapter lists commands
- **THEN** the catalog contains the registered `pi.compact` command
- **AND** the command declares `/compact` and its supported argument mode

#### Scenario: Claude Code exposes compact

- **WHEN** the Claude Code Adapter lists commands
- **THEN** the catalog contains the registered `claude.compact` command
- **AND** the command declares `/compact` and its supported argument mode

#### Scenario: Claude Code exposes init and recap

- **WHEN** the Claude Code Adapter lists commands
- **THEN** the catalog contains the registered `claude.init` and `claude.recap` commands
- **AND** both commands declare their invocations and argument mode `none`

#### Scenario: DeepSeek exposes only reviewed native commands

- **WHEN** a DeepSeek Session lists Harness commands
- **THEN** the Adapter reads that Session's current native `commands/list` catalog
- **AND** it maps valid advertised entries only to `dsh.compact`, `dsh.goal`, and `dsh.plan`, preserving their native relative order
- **AND** the mapped commands declare `/compact` with argument mode `none`, plus `/dsh-goal` and `/plan` with argument mode `text`
- **AND** `/dsh-goal` maps to native DSH `/goal` without entering Codex Desktop's built-in `/goal` flow
- **AND** it does not expose native `/feedback` because Codex Desktop owns a conflicting built-in command

#### Scenario: DeepSeek native catalog is missing or malformed

- **WHEN** a reviewed command is absent, has an incompatible input descriptor, or the native catalog contains invalid fields, duplicate names, or invalid descriptions
- **THEN** an absent or incompatible command is omitted, while a malformed catalog fails with a protocol error and exposes no partial result
- **AND** codexhost MUST NOT substitute a fixed catalog

#### Scenario: DeepSeek control and future commands remain excluded

- **WHEN** DSH advertises `permission`, `export`, or an unknown future command, or the Client contributes `/model`
- **THEN** none is exposed as a normal Harness command
- **AND** Permission Mode and Model selection remain on their existing first-class controls

### Requirement: Host validates and routes registered commands

The Host MUST obtain the current Harness command catalog before execution, MUST reject unknown command IDs, and MUST validate arguments at the command boundary. The Host MUST NOT provide an arbitrary native RPC passthrough.

#### Scenario: Unknown command is rejected

- **WHEN** a command execution request references an ID absent from the current catalog
- **THEN** the Host rejects the request
- **AND** no native Harness operation is started

#### Scenario: Unmatched slash input fails closed

- **WHEN** an external Thread submits slash-shaped text that matches no command in its current catalog
- **THEN** Host rejects the submission as an unavailable Harness command
- **AND** it does not send that text as a normal model Prompt or attempt an arbitrary native command

### Requirement: Native command semantics remain inside the owning Adapter

The Adapter MUST translate a registered command into the Harness-native operation and MUST translate native success, failure, cancellation, and busy states into Host-facing results or events. Shared layers MUST NOT contain Harness-specific RPC details.

#### Scenario: Pi compact uses native RPC

- **WHEN** `pi.compact` is executed
- **THEN** the Pi Adapter sends Pi's native `compact` request
- **AND** it does not send `/compact` as a normal Prompt

#### Scenario: Claude compact uses dedicated compact transport

- **WHEN** `claude.compact` is executed
- **THEN** the Claude Adapter calls the dedicated compact transport
- **AND** it does not submit `/compact` as a Host text Turn

#### Scenario: Claude init and recap use dedicated command transport

- **WHEN** `claude.init` or `claude.recap` is executed
- **THEN** the Claude Adapter calls the dedicated init or recap transport
- **AND** it does not submit those invocations as Host text Turns

#### Scenario: DeepSeek commands use the native command Remote

- **WHEN** a reviewed DeepSeek command is executed
- **THEN** the Adapter rechecks the current Session catalog and calls native `commands/execute` with the exact command line and cancellation signal
- **AND** codexhost does not reproduce the command's state changes or send it as a normal Prompt

### Requirement: Command UI and lifecycle follow Host contracts

A command MAY be discovered through the Host catalog. Renderer SHALL use an independent Composer control without changing Codex-native Slash lists. Its popover SHALL own layout, scrolling, focus and keyboard navigation. Adapter execution lifecycle MUST distinguish conversation from temporary operation before streaming output is presented. Conversation output SHALL use ordinary messages and native history; temporary operations MUST NOT create conversation history. Directory classification MUST NOT be the sole execution switch. Compact SHALL retain its existing command-acceptance path without waiting for `turn.started`.

#### Scenario: Text command selection claims the Composer

- **WHEN** the user selects a command with argument mode `text`
- **THEN** Renderer preserves the draft and attachments, inserts the invocation reference and uses the ordinary submission path

#### Scenario: Argument-free command selection executes directly

- **WHEN** the user selects a command with argument mode `none`
- **THEN** Renderer executes that registered command directly through the fixed Host command route

#### Scenario: Manual compaction is projected without a user Turn

- **WHEN** an Adapter reports native compaction execution
- **THEN** standard compaction progress and terminal outcome are displayed without adding an ordinary history Turn

#### Scenario: Official Codex compact retains native confirmation

- **WHEN** official Codex accepts `/compact` without returning a Turn ID
- **THEN** the existing native command route confirms acceptance without requiring an external submission receipt
- **AND** native compaction events keep their original presentation without a new correlation protocol or a terminal outcome inferred from another Turn

#### Scenario: DeepSeek command result text uses existing projection

- **WHEN** a reviewed native command returns only operation result text
- **THEN** the existing operation presentation displays the result and outcome without synthesizing native conversation history

#### Scenario: Skill produces a conversation

- **WHEN** a selected Skill starts a native conversation
- **THEN** its user message displays an inline icon and name followed by ordinary body text
- **AND** streaming replies and tools appear below it in conversation order, not inside a command card
- **AND** internal links and source paths are not exposed as Skill labels

#### Scenario: Native invocation remains unchanged

- **WHEN** the same visual Skill reference is submitted to different Harnesses
- **THEN** each Adapter retains its own native invocation and official Codex retains its native Skill input semantics

### Requirement: Commands remain isolated by Harness ownership

The Renderer and Host MUST expose only commands belonging to the current external Harness Thread. A command registered by one Harness MUST NOT appear or execute in another Harness Thread.

#### Scenario: Pi command is hidden from Codex Threads

- **WHEN** the current Thread is owned by Codex rather than Pi
- **THEN** the Pi command catalog is not exposed or rendered

### Requirement: Web 在已创建会话中统一发现原生命令与 Skills
Web SHALL 在已创建、可输入的本地共享 external Thread 的 `/`、`#`、`@` 菜单中展示当前 Harness 的原生命令与 Skills，其中 `/` 仅含界面操作、原生命令、Skills；`@`、`#` 依次含委派 Agent、原生命令、Skills、工作区文件。分类 SHALL 仅采用 Host 目录的原生元数据，缺失 Skill 标记时作为命令处理。未发送草稿、只读子会话、官方 Codex 与远程来源 MUST NOT 获得该新增入口。

#### Scenario: 展示和搜索原生目录
- **WHEN** 用户在受支持会话中打开菜单并输入查询
- **THEN** 菜单 SHALL 展示 Host 确认的名称、原生调用文本及可用说明，按调用文本和名称过滤
- **AND** 标记为 Skill 的条目 SHALL 进入 Skills 分组，其余进入原生命令分组，空分组隐藏
- **AND** 同名条目的执行身份 MUST NOT 根据显示名称猜测

#### Scenario: 未发送草稿
- **WHEN** 用户在尚未创建 canonical Thread 的草稿中打开菜单
- **THEN** 原有文件、模型和权限入口 SHALL 保持既有行为
- **AND** 菜单 MUST NOT 查询原生命令目录、启动 Harness、创建 Thread 或预热 Session

#### Scenario: 界面命令与原生命令同名
- **WHEN** 原生目录中的调用文本与 Web 的模型、权限或文件入口冲突
- **THEN** 原有界面入口 SHALL 继续工作且不重复注册
- **AND** 冲突的原生条目 SHALL 标记不可选择并说明名称冲突，不得覆盖界面操作或导致整个菜单失败
- **AND** 显示名称相同但身份或调用文本不同的其他条目 SHALL 继续可用

#### Scenario: 键盘与手机操作
- **WHEN** 用户通过键盘或窄屏触摸操作菜单
- **THEN** 用户 SHALL 能搜索、移动选择、确认及关闭菜单，并识别禁用原因
- **AND** 关闭菜单 SHALL 保留输入内容并恢复输入焦点

#### Scenario: 三种触发共享原生能力
- **WHEN** 用户通过 `/`、词首裸 `#`、`#查询`、裸 `@` 或 `@查询` 打开原生能力菜单
- **THEN** 原生命令和 Skills SHALL 使用相同目录、可用范围、选择、执行及错误/重连规则，不增加后端接口或第二套目录、缓存和执行引擎
- **AND** `/` SHALL 保留界面操作且不展示委派 Agent 或工作区文件；`@`、`#` SHALL 展示相同分组和排序，保留引用语法；输入框 MUST NOT 展示加号入口
- **AND** `@`、`#` SHALL 使用相同词首及引号规则，支持数字、长路径和带空格路径；词内、URL 片段、转义的触发符 MUST NOT 打开菜单
- **AND** `#` 后继续输入空格作为 Markdown 标题时 SHALL 撤下菜单并保留全部文字；选择 SHALL 仅替换当前触发片段

### Requirement: Web 命令目录查询只读取现有事实
Web SHALL 在打开受支持会话的菜单时查询其目录，查询不恢复或启动原生会话。搜索 SHALL 使用当前结果本地过滤。会话切换和重连 SHALL 使旧查询结果失效；加载中、静态目录、空结果与查询错误 SHALL 可区分，不能伪装成完整动态目录。

#### Scenario: 静态目录回退
- **WHEN** Host 返回静态目录来源
- **THEN** Web SHALL 展示已有内置命令，并提示项目命令和 Skills 需要会话启动后加载
- **AND** MUST NOT 扫描 Skill 文件、读取正文或启动额外进程补全目录
- **AND** 来源字段缺省 MUST NOT 自动解释为仍在加载动态目录

#### Scenario: 无跨会话污染
- **WHEN** 用户从会话 A 切到 B，或连接换代后旧查询才返回
- **THEN** 旧结果 MUST NOT 覆盖当前菜单、被用于当前会话执行或重新打开已关闭菜单
- **AND** 新查询 SHALL 按当前会话身份读取，不因相同 Harness 而复用其他工作目录的前端结果

#### Scenario: 查询失败不影响其他能力
- **WHEN** 命令目录查询失败或旧 Host 不支持查询接口
- **THEN** 原生命令区域 SHALL 显示可辨识的错误或不可用提示并允许用户重试
- **AND** 原有界面操作及已确认的委派 Agent 候选 MUST NOT 随之消失
- **AND** Web MUST NOT 将错误显示为空 Skills 列表或自行构造固定原生命令目录

### Requirement: Web 直接命令执行保持草稿与原生生命周期
选择无参数命令或菜单中的 `/compact` 时，Web SHALL 通过既有 Host 命令接口按稳定命令身份请求执行，不附带当前草稿参数。执行 SHALL 保留草稿正文、引用和附件；只有菜单触发文本可被移除。Host 的接受回执与执行完成 SHALL 明确区分，进度和结果沿用会话投影。

#### Scenario: 带草稿执行压缩
- **WHEN** 输入框中已有正文、引用和附件，用户选择 `/compact`
- **THEN** Web SHALL 仅提交该命令的默认参数，不提交草稿或上传待发送附件
- **AND** 正文、引用与附件 SHALL 保持可编辑，不能因执行成功或失败被清空
- **AND** 不得为此伪造普通用户消息或最终成功状态

#### Scenario: 会话忙或重复选择
- **WHEN** 当前会话正在执行操作、已有命令请求在途或已断线
- **THEN** 直接执行入口 SHALL 禁用并说明原因，不自动停止任务、排队或重试命令
- **AND** 前端检查后发生的并发变化 SHALL 由 Host 最终校验，拒绝原因反馈给用户

#### Scenario: 命令执行结果未知
- **WHEN** 命令发送后连接中断，无法确认是否已接受
- **THEN** Web SHALL 提示结果未知并保留草稿
- **AND** MUST NOT 自动重发命令或把断线解释为确定未执行

### Requirement: Web 带参数命令沿用普通输入提交
选择带参数的原生命令或 Skill 时，Web SHALL 保留原生调用文本并将其置于提交文本的命令起始位置，保留已有正文、引用及附件，让用户补充后显式发送；菜单选择本身 MUST NOT 执行。该路径 SHALL 使用既有普通消息提交及 Host 命令匹配，不读取或展开 Skill 正文，不由 Web 复制原生执行逻辑。

#### Scenario: 选择带参数 Skill
- **WHEN** 用户在已有草稿中选择参数模式为文本的 Skill
- **THEN** 输入框 SHALL 保留已有内容并提供该 Skill 的原生调用及参数编辑位置
- **AND** 只有用户发送后才提交到当前 Thread，不使用展示标签替代原生调用文本
- **AND** Web MUST NOT 通过其界面命令处理器把该调用改成另一套执行语义

#### Scenario: 无参数 Skill
- **WHEN** 原生目录将某个 Skill 声明为无参数调用
- **THEN** 选择行为 SHALL 遵循直接命令执行规则，而不是仅凭 Skill 分类强制要求文本参数

#### Scenario: 取消与提交拒绝
- **WHEN** 用户撤销命令选择，或 Host 拒绝提交
- **THEN** 既有正文、引用和附件 SHALL 保留供用户继续编辑
- **AND** 菜单不再显示的命令 MUST NOT 被 Web 降级为任意原生调用，最终可执行性仍由 Host 判断

#### Scenario: 普通输入与手工命令不回归
- **WHEN** 用户手工输入普通消息、未知斜杠文本或带参数的 `/compact`
- **THEN** Web SHALL 保持既有发送和 Host 校验语义，不因菜单点击的默认执行规则丢弃手工参数
- **AND** MUST NOT 改写普通消息的空白、附件或原有队列及 Steer 行为

### Requirement: Web 文件候选支持工作区递归搜索
`@`、`#` SHALL 将工作区文件放在最后一组，裸文件名查询对有界递归路径索引模糊排序，带目录前缀的查询浏览指定目录。候选仅包含路径，不读取内容。搜索 SHALL 限制结果和索引数量，排除依赖与构建目录，不跟随目录符号链接；取消或过期响应 MUST NOT 覆盖新查询。

#### Scenario: 子目录文件与引用
- **WHEN** 用户输入 `@config` 或 `#config`
- **THEN** SHALL 返回相同的子目录文件候选；选择后插入同一规范文件引用并保留正文
- **AND** 目录可用 Tab 或箭头继续下钻，含空格的路径可继续搜索

#### Scenario: 草稿与权限
- **WHEN** 已选工作区的草稿请求文件候选
- **THEN** SHALL 使用服务端保存的工作区，拒绝未知身份，不创建或预热原生 Thread
- **AND** MUST NOT 授予草稿终端能力

#### Scenario: 上传入口
- **WHEN** 用户选择 `/` 菜单的文件操作
- **THEN** SHALL 打开上传文件选择器；粘贴和拖放上传保持可用
