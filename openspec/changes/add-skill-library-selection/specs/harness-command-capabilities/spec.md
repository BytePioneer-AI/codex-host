# Spec Delta

## ADDED Requirements

### Requirement: 外部 Harness 命令目录不含 Skill
外部 Harness Adapter MUST NOT 把原生上报的 Skill 放入命令目录，Host 的外部 Thread 与草稿命令目录 SHALL 只含命令。Skill 分类元数据仅用于官方 Codex Thread 的原生 Skill 目录。原生 Skill 不再经命令匹配或命令执行链路提交；手工输入的原生 Skill 斜杠文本按未知命令规则处理。

#### Scenario: Claude Code 上报 Skill
- **WHEN** Claude Code Session 的原生目录同时上报命令与 Skill
- **THEN** Host 目录只包含其中的命令

#### Scenario: 手工输入 Skill 斜杠文本
- **WHEN** 外部 Harness 的 live 目录已就绪，用户手工发送 `/某Skill名 参数`
- **THEN** Host 按未知命令拒绝，不作为 Skill 执行

#### Scenario: 官方 Codex Skill 不变
- **WHEN** 官方 Codex Thread 查询命令目录
- **THEN** 结果仍包含 Codex 原生 Skill，提交时仍附带 Codex 原生 Skill 输入

### Requirement: Web 在已创建会话中统一发现原生命令
Web SHALL 在已创建、可输入的本地共享 external Thread 的 `/`、`#`、`@` 菜单中展示当前 Harness 的原生命令，其中 `/` 含界面操作、原生命令与 Skills；`@`、`#` 依次含委派 Agent、原生命令、Skills、工作区文件。Skills 分组 SHALL 来自 Skill 库。未发送草稿、只读子会话、官方 Codex 与远程来源 MUST NOT 获得原生命令入口。

#### Scenario: 展示和搜索原生命令
- **WHEN** 用户在受支持会话中打开菜单并输入查询
- **THEN** 菜单 SHALL 展示 Host 确认的命令名称、原生调用文本及可用说明，按调用文本和名称过滤，空分组隐藏
- **AND** 同名条目的执行身份 MUST NOT 根据显示名称猜测

#### Scenario: 未发送草稿
- **WHEN** 用户在尚未创建 canonical Thread 的草稿中打开菜单
- **THEN** 原有文件、模型和权限入口 SHALL 保持既有行为，Skills 分组按 Skill 库规则展示
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
- **WHEN** 用户通过 `/`、词首裸 `#`、`#查询`、裸 `@` 或 `@查询` 打开菜单
- **THEN** 原生命令 SHALL 使用相同目录、可用范围、选择、执行及错误/重连规则，Skills SHALL 使用相同的 Skill 库结果
- **AND** `/` SHALL 保留界面操作且不展示委派 Agent 或工作区文件；`@`、`#` SHALL 展示相同分组和排序，保留引用语法
- **AND** `@`、`#` SHALL 使用相同词首及引号规则，支持数字、长路径和带空格路径；词内、URL 片段、转义的触发符 MUST NOT 打开菜单
- **AND** `#` 后继续输入空格作为 Markdown 标题时 SHALL 撤下菜单并保留全部文字；选择 SHALL 仅替换当前触发片段

### Requirement: Web 带参数原生命令沿用普通输入提交
选择带参数的原生命令时，Web SHALL 保留原生调用文本并将其置于提交文本的命令起始位置，保留已有正文、引用及附件，让用户补充后显式发送；菜单选择本身 MUST NOT 执行。该路径 SHALL 使用既有普通消息提交及 Host 命令匹配，不由 Web 复制原生执行逻辑。

#### Scenario: 选择带参数命令
- **WHEN** 用户在已有草稿中选择参数模式为文本的命令
- **THEN** 输入框 SHALL 保留已有内容并提供该命令的原生调用及参数编辑位置
- **AND** 只有用户发送后才提交到当前 Thread，不使用展示标签替代原生调用文本
- **AND** Web MUST NOT 通过其界面命令处理器把该调用改成另一套执行语义

#### Scenario: 取消与提交拒绝
- **WHEN** 用户撤销命令选择，或 Host 拒绝提交
- **THEN** 既有正文、引用和附件 SHALL 保留供用户继续编辑
- **AND** 菜单不再显示的命令 MUST NOT 被 Web 降级为任意原生调用，最终可执行性仍由 Host 判断

#### Scenario: 普通输入与手工命令不回归
- **WHEN** 用户手工输入普通消息、未知斜杠文本或带参数的 `/compact`
- **THEN** Web SHALL 保持既有发送和 Host 校验语义，不因菜单点击的默认执行规则丢弃手工参数
- **AND** MUST NOT 改写普通消息的空白、附件或原有队列及 Steer 行为

## MODIFIED Requirements

### Requirement: Web 命令目录查询只读取现有事实
Web SHALL 在打开受支持会话的菜单时查询其命令目录，查询不恢复或启动原生会话。搜索 SHALL 使用当前结果本地过滤。会话切换和重连 SHALL 使旧查询结果失效；加载中、静态目录、空结果与查询错误 SHALL 可区分，不能伪装成完整动态目录。

#### Scenario: 静态目录回退
- **WHEN** Host 返回静态目录来源
- **THEN** Web SHALL 展示已有内置命令，并提示项目命令需要会话启动后加载
- **AND** MUST NOT 启动额外进程补全命令目录
- **AND** 来源字段缺省 MUST NOT 自动解释为仍在加载动态目录

#### Scenario: 无跨会话污染
- **WHEN** 用户从会话 A 切到 B，或连接换代后旧查询才返回
- **THEN** 旧结果 MUST NOT 覆盖当前菜单、被用于当前会话执行或重新打开已关闭菜单
- **AND** 新查询 SHALL 按当前会话身份读取，不因相同 Harness 而复用其他工作目录的前端结果

#### Scenario: 查询失败不影响其他能力
- **WHEN** 命令目录查询失败或旧 Host 不支持查询接口
- **THEN** 原生命令区域 SHALL 显示可辨识的错误或不可用提示并允许用户重试
- **AND** 原有界面操作、Skills 分组及已确认的委派 Agent 候选 MUST NOT 随之消失
- **AND** Web MUST NOT 将错误显示为空命令列表或自行构造固定原生命令目录

## REMOVED Requirements

### Requirement: Web 在已创建会话中统一发现原生命令与 Skills
**Reason**: Skills 不再来自外部 Harness 命令目录，由 Skill 库提供。
**Migration**: 由本变更新增的"Web 在已创建会话中统一发现原生命令"与 `skill-library` 能力取代。

### Requirement: Web 带参数命令沿用普通输入提交
**Reason**: Skill 不再作为带参数命令提交。
**Migration**: 命令部分由"Web 带参数原生命令沿用普通输入提交"取代，Skill 部分由 `skill-library` 的引用提交要求取代。
