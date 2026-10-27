# Spec Delta

## ADDED Requirements

### Requirement: 官方定时任务创建不继承外部 Harness 选择
系统 SHALL 保持官方定时任务创建入口使用官方 Codex，保留该入口的原生 Model 配置。普通聊天的 Harness 偏好、尚未提交的外部草稿和 codexhost 任务页的选择 SHALL 不改变该入口新建 Thread 的归属。此规则 SHALL 不改变已有 Thread 的不可变 Harness 归属。

#### Scenario: 先选择 Pi 再使用官方创建窗口
- **WHEN** 用户在普通聊天选择 Pi，随后在官方定时任务窗口创建任务
- **THEN** 新建 Thread 属于 Codex，官方 Model 参数不被外部路由覆盖
- **AND** 普通聊天的 Pi 选择无需被清空

#### Scenario: 两个创建入口交错提交
- **WHEN** 官方定时任务和 codexhost 外部任务的创建请求交错发生
- **THEN** 官方请求保持 Codex，外部请求使用自身显式配置
- **AND** 不以当前页面、全局 Harness 或请求先后顺序替代请求归属

#### Scenario: 打开已有外部任务
- **WHEN** 用户从官方任务列表打开或管理已经绑定 Pi 的任务
- **THEN** 该 Thread 保持 Pi 归属，后续执行不迁移为 Codex

### Requirement: 外部创建选择只作用于可确认归属的请求
系统 SHALL 将外部 Harness 创建配置限定到对应草稿或显式外部创建操作，不将其覆盖到同一 Host 的其他新建请求。无法确定外部请求归属时 SHALL 阻止该外部创建并报告不可用，不通过临时切换 Host 全局选择来实现隔离。

#### Scenario: 普通外部草稿提交
- **WHEN** 可确认归属的外部草稿提交并消费预热 Thread
- **THEN** 草稿继续使用自身 Harness 与 Model，既有预热失效和 Thread 归属规则仍成立

#### Scenario: 显式任务创建遇到绑定不兼容
- **WHEN** codexhost 无法可靠关联本次外部任务的配置和创建请求
- **THEN** 本次创建被阻止并显示原因，不静默创建 Codex Thread，也不影响官方请求
