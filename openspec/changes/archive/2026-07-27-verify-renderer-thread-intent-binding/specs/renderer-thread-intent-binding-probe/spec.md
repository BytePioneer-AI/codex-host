## ADDED Requirements

### Requirement: 已运行 Codex Desktop 不阻塞 Gate

Gate B MUST允许测试管理当前正在运行的 Codex Desktop。Gate MAY停止或终止已有实例并按本次 Shim/CDP配置重新启动；如果现有实例已具备本次测试配置且身份可确认，Gate MAY直接复用。实例存在本身 MUST NOT导致 `BLOCKED`。Gate MUST在结束时清理本次启动或接管的测试进程，并 MUST NOT修改官方安装、`app.asar`或全局环境。

#### Scenario: Gate 开始时 Desktop 正在运行

- **WHEN**Gate B 发现当前 Codex Desktop 已经运行
- **THEN**Gate MUST记录实例 PID并继续测试准备
- **AND**Gate MAY停止、终止或按本次配置重启该实例，而不是要求用户先正常关闭

#### Scenario: 现有实例已经满足测试配置

- **WHEN**Gate 能确认现有实例的身份、CDP endpoint和 Shim/Observer均属于本次测试配置
- **THEN**Gate MAY直接连接并复用该实例
- **AND**Gate 结束时 MUST清理本次接管的测试进程

### Requirement: Gate B 在真实 Codex Renderer 中提供当前 Harness 选择

Gate B MUST通过 direct CDP 向真实 Codex Renderer 注入最小 Codex/Pi 选择控件。选择 MUST保存在当前 Renderer document 中，并 MUST只表示当前活动 Composer 下一次新会话创建所使用的 Harness。Gate B MUST NOT要求为多个 Composer 建立注册表、synthetic cwd 身份或并发创建协议。

#### Scenario: 选择 Pi 后发送

- **WHEN**用户在当前 Renderer 选择 Pi，并从当前活动 Composer 首次发送消息
- **THEN**注入代码 MUST在发送动作发生时读取 Pi 这一最终选择
- **AND**更早的 Codex/Pi 切换 MUST NOT额外创建 Thread 或发送业务消息

#### Scenario: Renderer 重载

- **WHEN**Renderer document 重载并重新注入
- **THEN**Gate 控件 MUST恢复为明确的默认 Harness
- **AND**旧 document 的选择 MUST NOT继续影响新 document

### Requirement: Gate B 修改当前 Desktop 的真实创建 Request

Gate B MUST动态确认当前 Desktop 中一个能够在发送前修改真实新会话创建参数的 Renderer seam。注入代码 MUST把 Gate-local `harnessId`写入本次真实创建 Request 的 namespaced 扩展字段，并 MUST保持非创建调用不变。Gate B MAY根据当前 Desktop 的实际模块和调用形状选择 `start-conversation`、`thread/start`或等价 seam，不要求最内层边界，也不维护多个运行时 fallback。

#### Scenario: 创建 Request 携带最终选择

- **WHEN**当前活动 Composer 在选择 Pi 后产生真实创建 Request
- **THEN**同一个 Request MUST同时包含官方创建参数和 Gate-local `harnessId: "pi"`
- **AND**Harness 选择 MUST NOT通过独立 CDP 业务消息或发送后的补全步骤传递

#### Scenario: Codex 选择保持官方行为

- **WHEN**当前活动 Composer 在选择 Codex 后产生真实创建 Request
- **THEN**Observer MUST能判定该 Request 属于 Codex
- **AND**移除 Gate 扩展后的 Request MUST继续进入当前安装对应的官方 app-server

#### Scenario: 创建 seam 不可修改

- **WHEN**当前 Desktop 中无法找到可在发送前修改真实创建参数的 seam，或页面桥丢弃 Gate 扩展
- **THEN**Gate B MUST报告实际观察到的失败事实
- **AND**实现 MUST停止增加基于 cwd、焦点、时间窗口、FIFO或调用顺序的关联逻辑

### Requirement: Gate Observer 读取并移除 Harness 选择

Gate A Shim MUST仅在显式 Gate B 配置的 app-server 调用中路由到 Gate-only Node JSONL Observer。Observer MUST从目标创建 Request 读取合法的 Codex/Pi `harnessId`，并 MUST在任何官方转发前移除 Gate 扩展。其他 CLI 调用和与目标创建无关的 JSONL line MUST保持现有透明行为。

#### Scenario: Observer 收到 Pi 创建选择

- **WHEN**Observer 收到携带 `harnessId: "pi"`的真实创建 Request
- **THEN**Observer MUST记录已观察到 Pi 路由选择
- **AND**该 Request MUST NOT作为普通 Codex 创建请求进入官方 Codex Agent Loop

#### Scenario: Observer 收到 Codex 创建选择

- **WHEN**Observer 收到携带 `harnessId: "codex"`的真实创建 Request
- **THEN**Observer MUST移除 Gate 扩展并把官方字段转发给当前安装对应的 app-server
- **AND**官方 Response MUST原样返回 Desktop

#### Scenario: Harness 选择缺失或非法

- **WHEN**目标 Gate 创建 Request 缺少 Harness 选择或使用 Codex/Pi 之外的值
- **THEN**Observer MUST使当前 Gate 场景失败并输出不含 Prompt 正文的诊断
- **AND**Observer MUST NOT从页面全局、cwd或最近请求补全 Harness

### Requirement: 真实 Gate 关闭最小技术事实

真实 Gate B MUST至少完成一次 Codex 选择和一次 Pi 选择的当前活动 Composer 创建尝试。通过结论只表示 Renderer 能将当前选择写入真实创建 Request，Observer 能读取该选择并防止 Pi 请求进入官方 Codex Agent Loop；它 MUST NOT声称 Pi 已执行、Thread 映射已持久化或完整产品链路已完成。

#### Scenario: 最小 Gate 通过

- **WHEN**Codex 创建尝试保持官方行为，且 Pi 创建尝试的真实 Request 到达 Observer 并在官方 Agent Loop 前被拦截
- **THEN**Gate B MUST报告 `PASS`
- **AND**报告 MUST记录 Desktop/CLI 版本、实际创建 seam、Gate 字段位置和两个路由结果

#### Scenario: 环境无法运行真实验证

- **WHEN**Gate 停止或重启当前 Desktop 后仍无法启用 CDP、注入 Renderer或完成一次受控创建尝试
- **THEN**Gate B MUST报告 `BLOCKED`和直接解除条件

#### Scenario: 选择未到达 Observer

- **WHEN**真实创建已经发生但 Observer 没有在该 Request 中收到发送时选择
- **THEN**Gate B MUST报告 `FAIL`
- **AND**后续实现 MUST根据真实调用形状调整 Renderer seam，而不是扩建并发或持久化基础设施
