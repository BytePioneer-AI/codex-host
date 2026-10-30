# Spec Delta

## ADDED Requirements

### Requirement: Web 在已创建会话中统一发现原生命令与 Skills
Web SHALL 在已创建、可输入的本地共享 external Thread 的 `/`、`#`、`@` 共享菜单及加号入口中展示当前 Harness 的原生命令与 Skills，并与界面操作及委派 Agent 分组区分。分类 SHALL 仅采用 Host 目录的原生元数据，缺失 Skill 标记时作为命令处理。未发送草稿、只读子会话、官方 Codex 与远程来源 MUST NOT 获得该新增入口。

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
- **THEN** 原生命令、Skills 和委派 Agent SHALL 使用相同目录、可用范围、选择、执行及错误/重连规则，不增加后端接口或第二套目录、缓存和执行引擎
- **AND** `/` 和加号 SHALL 保留界面操作，`#`、`@` 展示同一份原生能力分组，`@` 保留既有文件及会话引用语法
- **AND** `#123`、`##`、词内或 URL 片段、转义的 `\#` MUST NOT 打开菜单
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
