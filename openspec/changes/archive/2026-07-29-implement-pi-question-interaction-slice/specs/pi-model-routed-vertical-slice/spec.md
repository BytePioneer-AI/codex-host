## MODIFIED Requirements

### Requirement: Pi 首轮与第二轮文本在 Codex UI闭环

对已归属 Pi的 Thread，Host Runtime MUST把用户文本交给真实本地 `pi --mode rpc` Native Session，并 MUST把 Pi产生的文本增量、Tool生命周期、可靠File Change、阻塞式Question、完成和明确错误转换为当前 Codex UI可消费的最小 app-server事件或Server Request。Pi Harness MUST拥有 Agent Loop；请求 MUST NOT回退给 Codex Harness。相同 Host Thread的后续 Turn和Interaction MUST继续使用相同 Pi Native Session。

#### Scenario: Pi首轮文本回复

- **WHEN**用户在新 Pi Thread发送第一条文本消息
- **THEN**Pi Adapter MUST在真实 Pi Native Session执行 Agent Loop
- **AND**Codex UI MUST显示来自 Pi的文本增量和唯一完成结果或明确错误

#### Scenario: 同 Thread第二轮

- **WHEN**首轮完成后用户在同一 Pi Thread发送第二条文本消息
- **THEN**该 Turn MUST进入与首轮相同的 Pi Native Session
- **AND**返回事件 MUST继续关联当前 Host Thread且不得进入官方 Codex Agent Loop

#### Scenario: Pi用户Extension发起阻塞式Question

- **WHEN**Pi中已有的用户Extension在活动Turn中发出`select`、`confirm`、`input`或`editor` Extension UI Request
- **THEN**Pi Adapter MUST把它映射为属于同一Host Turn的Question
- **AND**Codex UI MUST显示原生用户输入界面并把回答精确返回同一个Pi原生请求

#### Scenario: Question早于Prompt Response

- **WHEN**Pi Extension在Prompt preflight中发出Question且Pi Prompt Command尚未返回
- **THEN**Host MUST已经建立Turn与Interaction路由并允许Desktop回答
- **AND**系统 MUST NOT因互相等待Prompt Response和Question Response而死锁

#### Scenario: codexhost不向Pi注入Question Tool

- **WHEN**Host启动Pi Native Session
- **THEN**启动参数 MUST NOT包含codexhost拥有的`--extension`
- **AND**Pi可用Tool集合 MUST只来自Pi默认能力和用户原有配置
- **AND**Question映射 MUST只在Pi实际发出Extension UI Request时发生

#### Scenario: 当前 PoC不伪造未实现能力

- **WHEN**Pi产生Approval、Snapshot、Resume、Fork或本change未接管的行为
- **THEN**系统 MUST NOT伪造为已支持的Codex UI能力
- **AND**MUST返回明确受限结果或按已评审的最小错误语义终止当前操作
