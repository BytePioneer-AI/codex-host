# Spec Delta

## ADDED Requirements

### Requirement: Web 提供身份明确的委派 Agent 候选列表
Web SHALL 在未发送的 Web 草稿及已创建、可输入的本地共享 external Thread 的 `/`、`#` 共享菜单、`@` 菜单与加号入口中提供独立的“委派 Agent”分组。首版候选 SHALL 取自 Web 已有、已确认就绪且在当前 Web 可见范围内的会话 Harness 目录，复用其名称、图标与展示顺序，并支持按名称和 Harness ID 搜索。该列表不是 Model、Provider、原生 Subagent 角色或既有 Thread 列表，也不声称覆盖 CLI 的全部委派目标。

#### Scenario: 列出可用目标
- **WHEN** 用户在受支持会话中打开菜单
- **THEN** 委派分组 SHALL 展示已有 Web 目录中的就绪会话 Harness，排除用量统计插件及未确认就绪的目标
- **AND** MUST NOT 为打开或搜索该列表逐个启动 Harness、发起模型请求或创建委派任务
- **AND** 原生命令目录为空或加载失败 MUST NOT 阻止显示已确认的委派候选

#### Scenario: 保留真实 Harness 身份
- **WHEN** 目录包含名称相同的两个 Harness，或包含名称为 Codex 的 `codex-cli`
- **THEN** 菜单 SHALL 展示足以区分目标的 Harness ID，并在选择后保留该身份
- **AND** `codex-cli` MUST NOT 被改写成官方 `codex`
- **AND** Web 目录未提供的官方 Codex 或其他目标 MUST NOT 被硬编码补入

#### Scenario: 同 Harness 委派与动态变化
- **WHEN** 当前 Thread 所属 Harness 也是就绪候选，或目标可用性发生变化
- **THEN** 同 Harness 候选 SHALL 可选，用于请求独立子 Thread，而非切换当前 Session
- **AND** 候选 SHALL 随既有 Web 目录更新；选择已撤下的候选 MUST NOT 插入错误目标，应提示重新选择

#### Scenario: 未发送草稿选择目标
- **WHEN** 用户在未发送的 Web 草稿中通过 `/`、`#`、`@` 或加号打开菜单并选择目标
- **THEN** 委派分组 SHALL 复用已有就绪 Harness 目录并仅插入目标引用，保留正文和附件
- **AND** MUST NOT 查询原生命令目录、创建 canonical Thread、预热 Session 或发送消息
- **AND** 原生命令与 Skills SHALL 仍不可用

#### Scenario: 只读及未支持来源
- **WHEN** 当前页面是只读子会话、官方 Codex 或远程来源
- **THEN** 本次新增的委派分组 SHALL 不可用

### Requirement: Web 选择委派 Agent 只编辑当前输入
选择委派 Agent SHALL 在输入位置插入可识别的 `@名称` 引用，并保留稳定 Harness 身份。引用 SHALL 可删除、撤销、复制并与正文及其他引用混排；已有正文和附件 SHALL 保留。选择动作 MUST NOT 发送消息、切换当前 Harness、创建子 Thread、预读目标历史或直接调用委派执行接口。

#### Scenario: 插入并取消选择
- **WHEN** 用户在正文中打开菜单并选择目标，然后删除或撤销引用
- **THEN** 仅菜单触发文本 SHALL 被引用替换，其他正文、原有引用和附件不变
- **AND** 撤销或删除 SHALL 只影响本地草稿，不产生任何原生操作

#### Scenario: 多目标与复制
- **WHEN** 用户插入多个目标引用，或复制包含目标引用的输入
- **THEN** 每个引用 SHALL 保留各自真实 Harness ID，不以展示名称寻址
- **AND** 复制及既有草稿序列化 SHALL 保留可恢复目标身份的既有委派引用文本，不退化成有歧义的裸名称

#### Scenario: 保持现有输入功能
- **WHEN** 用户使用文件或会话引用、上传附件、打开模型或权限菜单
- **THEN** 委派分组 MUST NOT 接管这些入口、改变其身份或破坏其编辑行为
- **AND** `@`、`#` SHALL 作为同一原生能力菜单的触发别名，共享原生命令、Skills 和委派候选的目录、缓存、选择及提交路径，保留既有文件及会话引用

### Requirement: Web 委派引用通过既有用户提交路径生效
用户发送含委派引用的消息时，Web SHALL 通过当前 Thread 的普通消息路径提交既有身份明确的引用，由现有 Host 引用处理和当前 Agent 的委派 Skill/CLI 流程决定执行。Web MUST NOT 自行添加委派教程或指令、调用 CLI、创建任务、自动注册 watch 或把发送回执当作子任务已创建。实际目标能力及可用性仍由既有执行链路校验。

#### Scenario: 显式发送委派请求
- **WHEN** 用户发送含目标引用和任务描述的消息
- **THEN** Web SHALL 将消息提交给当前 Thread，保留目标身份并沿用既有队列或 Steer 规则
- **AND** 菜单层 MUST NOT 并行发起另一份委派、切换当前 Harness 或自行选择目标 Model/Thinking/权限
- **AND** 子 Thread 是否建立及执行结果 SHALL 以既有委派反馈为准

#### Scenario: 草稿首条消息包含委派引用
- **WHEN** 用户显式发送包含目标引用的草稿首条消息
- **THEN** Web SHALL 沿既有新会话路径创建当前 Thread 并提交首条消息，保留真实目标身份、正文和附件
- **AND** 菜单层 MUST NOT 额外创建子任务、注册 watch 或提交原生命令

#### Scenario: 普通文本不升级为委派选择
- **WHEN** 用户仅讨论 Harness 名称、输入裸 `@名称` 或引用普通 Thread
- **THEN** Web MUST NOT 自动构造委派引用、追加委派说明或启动目标任务
- **AND** 普通文本的解释 SHALL 继续由当前 Agent 及既有 Skill 规则负责

#### Scenario: 提交失败或结果未知
- **WHEN** 含委派引用的消息被拒绝，或提交结果因断线而未知
- **THEN** Web SHALL 保留输入及目标身份并反馈对应状态
- **AND** MUST NOT 自动重发或宣称委派任务已启动
