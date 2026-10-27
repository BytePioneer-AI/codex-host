# Spec Delta

## Purpose

允许用户在 codexhost 自有页面为外部 Harness 创建固定聊天的本地周期任务，并统一管理本地 Codex 与外部 Harness 的固定聊天日程。复用 Desktop 的持久化与执行触发，保持各目标聊天的配置和归属。

## ADDED Requirements

### Requirement: 自有页面显式配置外部任务聊天
系统 SHALL 在 Desktop 内的 codexhost 页面提供任务内容、外部 Harness、Model、每日或每周的本地时间设置，以及高级设置中的可选工作目录。Harness 与 Model SHALL 来自当前本地 Host 的可用插件及其模型目录，选择 SHALL 只作用于本次创建。第一版 SHALL 不提供每次新建聊天、远程 Host 或 Worktree 选项。

#### Scenario: 用户配置一个外部任务
- **WHEN** 用户选择可用 Harness 及其有效 Model，并填写任务内容和周期
- **THEN** 页面允许创建绑定固定聊天的本地任务
- **AND** 普通聊天的 Harness 偏好和官方 Model 默认值保持不变

#### Scenario: 切换 Harness 后原 Model 不适用
- **WHEN** 用户切换 Harness 或所选 Model 已不在其目录中
- **THEN** 页面重新解析所选 Harness 的有效模型选择，未确定有效 Model 时禁止提交
- **AND** 系统不得静默改用另一个 Harness

### Requirement: 工作目录可省略并复用 Desktop 默认工作区
用户 SHALL 无需输入工作目录即可创建任务。留空时系统 SHALL 使用 Desktop 为无项目聊天分配的独立工作区，包括用户配置的默认根目录；显式填写时 SHALL 使用有效的指定目录。生成的路径 SHALL 作为目标 Thread 的工作目录，后续调度 SHALL 继续使用该路径。

#### Scenario: 用户未填写目录
- **WHEN** 工作目录为空且 Desktop 默认工作区分配可用
- **THEN** 系统分配独立的持久工作目录，并将其用于目标 Thread
- **AND** 后续执行不因日期变化而分配新目录

#### Scenario: 自定义默认根目录
- **WHEN** 用户已在 Desktop 修改默认工作区根目录且本次未填写目录
- **THEN** 系统遵循该配置，不硬编码用户主目录下的固定路径

#### Scenario: 显式目录无效或默认工作区分配失败
- **WHEN** 指定目录无法使用，或留空时无法分配默认工作区
- **THEN** 创建失败并显示原因，不切换到系统临时目录或其他未选择的目录

### Requirement: 日程绑定唯一固定 Thread 并复用 Desktop 触发
每个成功创建的任务 SHALL 绑定一个新建的外部 Thread。日程 SHALL 由 Desktop 保存并触发，后续各次执行 SHALL 返回同一 Thread，使用其 Harness、工作目录及当前 Model 配置。系统 SHALL 不依赖 Harness 自带定时器，不为日程复制一份独立模型配置，也不得在创建时立即执行任务正文。

#### Scenario: 到期执行外部任务
- **WHEN** Desktop 运行中且任务到期，目标 Thread 可恢复且可接收输入
- **THEN** Desktop 触发该 Thread 的执行，codexhost 按其既有 Harness 归属执行任务并显示结果
- **AND** 不创建新的执行 Thread，也不改为官方 Codex 执行

#### Scenario: 用户切换页面或重新打开 Desktop
- **WHEN** 用户离开创建页，或重启 Desktop 后仍有有效日程和目标 Thread
- **THEN** 日程不依赖创建页保持挂载，Desktop 能恢复所需聊天状态并继续调度

#### Scenario: 用户修改目标聊天的 Model
- **WHEN** 用户通过现有聊天配置修改 Model 后再次触发任务
- **THEN** 执行遵循该 Thread 的有效配置，创建页不会恢复旧 Model

### Requirement: 创建结果和失败保持可辨识
系统 SHALL 只在确认目标 Thread 与日程绑定成功后报告创建成功，并提供目标聊天入口和任务列表。提交进行中 SHALL 防止重复提交；创建部分失败或结果不确定时 SHALL 如实显示已确认的状态，不自动重放写请求或删除可能已绑定的 Thread。

#### Scenario: 日程保存失败
- **WHEN** 已创建目标 Thread，但日程保存明确失败
- **THEN** 页面报告未完成创建并保留目标聊天入口，允许本次页面流程复用该 Thread 重试
- **AND** 不执行任务正文，不自动创建第二个 Thread

#### Scenario: 保存结果不确定
- **WHEN** 日程创建请求发出后连接中断，无法确认是否已保存
- **THEN** 页面提示用户在官方任务列表核对，不报告成功或自动重试创建

### Requirement: 自有页面统一管理本地固定聊天日程
自有页面 SHALL 同时列出本地已确认归属官方 Codex 与外部 Harness 的固定聊天日程，不按创建入口过滤；显示名称、Harness、时间与活动/暂停状态，均支持打开历史聊天、修改名称/正文/时间、暂停/恢复及确认后删除。读写 SHALL 复用 Desktop 的同一份日程；不得修改云端、远程或其他不支持类型的任务，不复制聊天历史或另建存储。

#### Scenario: 官方与外部任务共同展示
- **WHEN** Desktop 存在官方 Codex 与 Pi 等外部 Harness 的本地固定聊天任务
- **THEN** 两类任务出现在同一列表，准确标明 Harness，均可打开历史聊天并管理日程
- **AND** 官方任务不会被转为外部 Thread，自有新建表单仍只创建外部 Harness 任务

#### Scenario: 管理官方 Codex 日程
- **WHEN** 用户从自有页面修改、暂停/恢复或确认删除一个官方 Codex 固定聊天任务
- **THEN** 操作作用于原日程，保留聊天归属、Model 配置与历史，不发起外部 Harness 创建或取消当前 Turn
- **AND** 官方页面读取同一结果

#### Scenario: 查看历史并重新进入列表
- **WHEN** 用户重新进入页面或刷新列表，并打开一个已创建任务
- **THEN** 列表展示 Desktop 的当前日程状态，聊天入口打开其固定 Thread 的历次执行记录
- **AND** 不依赖上次创建页面的内存数据

#### Scenario: 修改任务内容与时间
- **WHEN** 用户保存名称、正文或每日/每周时间的修改
- **THEN** 更新原日程，保留目标 Thread、Harness、工作目录和其他未修改字段，不创建第二个任务或聊天
- **AND** 官方任务界面读取同一更新结果；Model 继续由目标聊天配置决定

#### Scenario: 原生日程超出基础编辑器范围
- **WHEN** 某个本地固定聊天日程使用基础每日/每周编辑器不能表达的规则
- **THEN** 页面保留该规则，不以默认时间覆盖它；仅改名称或正文仍保留原周期

#### Scenario: 暂停或删除任务
- **WHEN** 用户暂停日程，或确认删除日程
- **THEN** 调用 Desktop 对应操作并重新读取状态，后续调度遵循原生暂停或删除语义
- **AND** 保留聊天记录及工作区文件，不将操作扩展为停止当前 Turn

#### Scenario: 归属或写入结果无法确认
- **WHEN** 无法确认目标日程属于本地固定聊天或无法确认其 Harness 归属，或修改/删除结果未知
- **THEN** 不执行未经确认归属的写入，不将未知结果显示为成功或自动重放操作，并提供刷新核对入口

### Requirement: 不可用和执行边界遵循实际能力
系统 SHALL 仅在本地 Desktop 任务服务、工作区及聊天接入可用时开放创建；缺失或不兼容时 SHALL 说明原因。执行的忙碌、审批、失败和调度时序 SHALL 遵循 Desktop 与目标 Harness 的既有行为，不增加自动授权、并发执行、补跑或独立后台调度策略。

#### Scenario: Desktop 服务不兼容
- **WHEN** 当前版本无法验证任务服务或固定聊天调度所需接口
- **THEN** 页面禁止创建并显示不可用状态，不写入日程文件或启用替代计时器

#### Scenario: 目标 Harness 需要用户输入
- **WHEN** 定时执行期间 Harness 请求审批或提问
- **THEN** 聊天显示对应等待状态，系统不自动批准，也不报告任务已完成
