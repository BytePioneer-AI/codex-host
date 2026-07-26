## ADDED Requirements

### Requirement: Gate B必须复用已验证基础并明确新增能力

Gate B Probe MUST复用Gate A已验证的App/CLI发现、官方CLI定位、Shim和进程监督能力。Probe MUST明确增加本次Desktop的remote debugging启动参数、Gate-only Node JSONL Observer和Renderer出站Request包装，MUST NOT把Gate A字节透明代理描述为已经具备协议观察或改写能力。Probe MUST NOT建设完整Host Runtime、Protocol Core、通用CDP框架或Fake CDP endpoint。

#### Scenario: app-server调用进入Gate Observer

- **WHEN**Gate启动的Desktop通过Shim发起app-server调用
- **THEN**Shim MUST将该调用路由到受监督的Gate-only Node JSONL Observer
- **AND**其他CLI调用 MUST继续进入当前安装对应的官方CLI
- **AND**Observer MUST启动当前安装对应的官方app-server而不是全局`codex`

#### Scenario: 转发无关JSONL消息

- **WHEN**Desktop和官方app-server交换与目标创建Request无关的合法JSONL line
- **THEN**Observer MUST按原顺序和内容转发该line
- **AND**Gate B增量测试 MUST聚焦新增观察、扩展移除和Response关联，不重复Gate A完整生命周期矩阵

### Requirement: Probe使用最小direct CDP注入真实Renderer

Gate B Probe MUST只连接由本次运行启动的Codex Desktop，并 MUST通过进程归属、target type和页面行为确认Renderer。Probe MUST只实现target查询、一个CDP WebSocket连接、new-document脚本、当前document注入和健康检查所需命令，MUST NOT使用Playwright控制路径或维护第二套CDP fallback。

#### Scenario: 启动Desktop并连接Renderer

- **WHEN**目标Desktop未运行且当前平台支持本次进程级remote debugging参数
- **THEN**Probe MUST只为本次进程树设置临时`CODEX_HOME`、synthetic cwd和loopback随机CDP endpoint
- **AND**Controller MUST只连接属于该实例且通过行为探测的Renderer target
- **AND**Gate结束后本次Desktop、CDP endpoint、Shim、Observer和官方CLI MUST有界退出

#### Scenario: Desktop已经运行

- **WHEN**Probe发现目标Codex Desktop已有运行实例
- **THEN**Probe MUST拒绝连接、复用或终止该实例
- **AND**Gate MUST返回可操作的`BLOCKED`诊断

#### Scenario: 注入和页面重载

- **WHEN**Controller首次注入、重复确认当前document或Renderer发生顶层重载
- **THEN**同一document MUST最多存在一个Gate控件和一个活动发送边界包装器
- **AND**新document MUST重新注入，旧JavaScript realm中的未完成草稿 MUST不得继续发送
- **AND**无法确认target、注入或重载恢复时当前平台Gate MUST标记为`BLOCKED`

### Requirement: Composer草稿遵循发送时快照和显式创建生命周期

Renderer中的Agent、Model、Thinking和cwd MUST按可区分Composer草稿隔离。草稿 MUST遵循`draft → creating → sent/abandoned`最小生命周期；只有首次发送才能快照最终状态并生成CreateRequestId，创建期间 MUST拒绝第二次用户提交。

#### Scenario: 连续切换后发送

- **WHEN**用户在同一Composer中多次切换Codex和Pi并最终发送
- **THEN**CreateThreadIntent MUST只包含发送动作发生时的最终Harness和草稿字段
- **AND**早先选择 MUST NOT额外生成Intent或Thread创建Request

#### Scenario: 两个草稿独立创建

- **WHEN**两个可区分Composer分别选择不同Harness并交错发送
- **THEN**每个草稿 MUST生成自己的CreateRequestId和完整Intent
- **AND**一个草稿的创建状态、成功或失败 MUST NOT修改另一个草稿

#### Scenario: 创建失败后重试

- **WHEN**一个创建请求失败并进入abandoned，用户再次发送
- **THEN**新发送 MUST重新快照当前草稿并生成新的CreateRequestId
- **AND**新Request MUST NOT复用失败ID或旧document草稿

### Requirement: 完整创建意图必须存在于同一个真实创建Request

Probe MUST捕获当前Desktop首次发送的真实创建Method和最内层统一app-server发送边界。Renderer包装器 MUST在调用原发送函数前，把完整strict CreateThreadIntent写入同一个创建Request的Gate-only namespaced扩展字段。Harness归属 MUST NOT通过独立CDP Intent消息、preflight、时间窗口、FIFO、最近选择、`selectedHarness`或`nextHarness`补全。

#### Scenario: 包装真实统一出站边界

- **WHEN**当前Renderer首次发送最终经过已确认的统一app-server创建边界
- **THEN**Gate MUST只包装该边界并保持非创建Method行为不变
- **AND**同一个创建Request MUST同时包含官方创建参数和完整CreateThreadIntent
- **AND**CreateThreadIntent MUST包含CreateRequestId、HarnessId、cwd及实际存在的可选Model/Thinking字段

#### Scenario: 不建立第二创建通道

- **WHEN**Renderer生成CreateThreadIntent
- **THEN**Intent MUST只随目标创建Request发送
- **AND**Gate MUST NOT另外发送`thread.create.intent`、accepted/rejected握手或任何需要与创建Request进行keyed join的业务消息

#### Scenario: 单Request扩展不可用

- **WHEN**环境足以验证但namespaced完整Intent扩展不能从真实Renderer到达Observer
- **THEN**当前平台Gate B MUST标记为`FAIL`
- **AND**本change MUST NOT通过自定义Method、synthetic model、第二carrier或独立Intent通道掩盖结果

#### Scenario: 出站边界不可确认

- **WHEN**当前Renderer的统一创建边界不能被可靠定位或不能在调用原函数前同步修改Request
- **THEN**当前平台Gate B MUST标记为`BLOCKED`
- **AND**报告 MUST记录实际观察和解除条件

### Requirement: Observer必须移除Gate扩展并关联真实Response

Observer MUST strict校验同一个创建Request中的完整CreateThreadIntent，在转发官方app-server前移除Gate-only扩展，并按原JSON-RPC `id`观察对应Response。Observer MUST只报告`CreateRequestId → observed Codex Thread ID → HarnessId`，MUST NOT分配Host Thread ID或声称外部Harness已经运行。Pi标记Thread的首个`turn/start` MUST在进入官方Codex Agent Loop前被阻止。

#### Scenario: 提取Intent并透明转发官方Request

- **WHEN**Observer收到包含合法完整Intent的目标创建Request
- **THEN**Observer MUST记录该Request的JSON-RPC `id`、CreateRequestId和HarnessId
- **AND**转发给官方app-server的Request MUST移除Gate-only扩展并保留其他字段

#### Scenario: 拒绝缺失或非法Intent

- **WHEN**目标创建Request缺少完整Intent，或Intent包含未知字段、非法Runtime值、空身份或不可序列化值
- **THEN**Observer MUST拒绝该Gate场景且不得从其他状态补全Harness
- **AND**受限诊断 MUST NOT包含Prompt、完整payload或用户页面数据

#### Scenario: 关联Response Codex Thread ID

- **WHEN**官方app-server返回与目标Request相同JSON-RPC `id`的成功Response
- **THEN**Observer MUST从已捕获位置取得Codex Thread ID并关联原CreateRequestId和HarnessId
- **AND**报告 MUST明确该ID是observed Codex Thread ID而不是Host Thread ID

#### Scenario: 阻止错误Harness Agent Loop

- **WHEN**Observer已把一个成功创建的observed Codex Thread ID关联到Pi Harness，随后收到该Thread的首个`turn/start`
- **THEN**Observer MUST在该Request进入官方app-server前返回受控Gate错误
- **AND**报告 MUST证明官方Codex Agent Loop没有执行该Turn且不得声称Pi已经执行

#### Scenario: 两个Request交错且反序完成

- **WHEN**两个自包含创建Request交错发送且Response反序完成
- **THEN**Observer MUST按各自JSON-RPC `id`关联Response
- **AND**每个结果 MUST保持该Request自身携带的CreateRequestId和HarnessId，不依赖提交或完成顺序

### Requirement: 真实Gate必须覆盖五类不可替代场景

真实Gate B MUST执行CDP注入/重载、真实首发、发送前快速切换、两个Composer并发、失败重试/重载隔离五类场景。普通Hermetic测试 MUST按行为覆盖草稿生命周期、单Request Schema、透明转发、Response关联和隐私边界，不得以固定测试数量代替行为要求。

#### Scenario: 五类场景全部成立

- **WHEN**五类真实场景全部执行并满足单Request绑定、安全和隔离不变量
- **THEN**当前平台Gate B MUST标记为`PASS`
- **AND**报告 MUST说明每个observed Codex Thread ID由同一创建Request中的完整Intent确定Harness

#### Scenario: 并发场景无法形成

- **WHEN**当前Desktop无法自动或通过可重复人工步骤形成两个可区分Composer
- **THEN**当前平台Gate B MUST标记为`BLOCKED`
- **AND**Hermetic并发测试 MUST NOT被描述为真实Renderer并发证据

#### Scenario: 发生错误绑定或旧状态污染

- **WHEN**任一真实场景使用了错误Harness、重复创建、复用失败ID或允许重载前草稿污染新Request
- **THEN**当前平台Gate B MUST标记为`FAIL`
- **AND**正式Agent UI、Protocol Core和Mapping Store MUST停止采用当前方案

### Requirement: Gate证据必须脱敏、平台限定并与普通检查隔离

普通质量检查 MUST不得启动真实Desktop、访问真实CDP、读取Renderer用户profile、启动官方CLI或Pi、访问网络。真实Gate可以使用当前Renderer profile维持真实登录状态，但 MUST把CDP操作限制为target确认、注入、健康检查和synthetic Composer操作，并 MUST使用allowlist证据。

#### Scenario: 运行普通质量检查

- **WHEN**开发者或CI运行`npm run check`
- **THEN**草稿生命周期、单Request Schema、扩展移除、透明转发、错误Harness Turn阻止、Response关联和Fixture隐私测试 MUST确定性执行
- **AND**流程 MUST不要求安装Codex Desktop、用户认证、Pi或网络

#### Scenario: 使用真实Renderer profile

- **WHEN**真实Gate使用当前Desktop Renderer profile
- **THEN**报告 MUST明确临时`CODEX_HOME`只隔离官方CLI数据
- **AND**Probe MUST NOT采集无关DOM、账号、项目列表、Local Storage、完整Console、网络流量或页面截图

#### Scenario: 准备可提交证据

- **WHEN**真实Gate产生协议和场景摘要
- **THEN**可提交Fixture MUST只保留Method、字段名、类型占位符、五类场景结果和布尔不变量
- **AND**MUST排除Prompt、Transcript、Tool输出、DOM正文、截图、真实ID、绝对路径、完整环境、token和用户配置

#### Scenario: 只有Windows真实证据

- **WHEN**Windows真实Gate通过但macOS尚未运行真实Gate
- **THEN**文档 MUST只声明Windows Gate B `PASS`
- **AND**MUST NOT从Hermetic测试推断macOS CDP启动和Renderer注入已经验证
