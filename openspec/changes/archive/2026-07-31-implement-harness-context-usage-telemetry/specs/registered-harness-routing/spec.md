## ADDED Requirements

### Requirement: 已注册外部 Harness 必须共享一条 Usage 路由路径

Host Runtime MUST 从所属且已注册的 `HarnessSession` 消费规范化 Usage，保留最新的已加载 Thread 快照，并为每个外部 Harness 调用同一个 Protocol Core Usage projector。Host MUST NOT 查询 Pi RPC、Claude SDK、Model catalogs 或原生 Session 文件来获取 Usage；没有可投影 Usage 的有效外部 Thread MUST 保持外部归属，而不是回落到官方 Codex。

#### Scenario: Pi 与另一个 Adapter 共存

- **WHEN** Pi 和第二个已注册 Fake Adapter 分别为各自 Thread 发出 Usage
- **THEN** 两者 MUST 经过相同的 External Thread 状态和 Protocol projector 代码
- **AND** 一个 Session 的操作或 Telemetry MUST NOT 更新另一个 Thread

#### Scenario: 已注册 Harness 不提供 Usage

- **WHEN** 外部 Thread 所属 Session 没有报告可靠 Usage
- **THEN** Host MUST 继续通过该 Harness 路由其 Turn、history、control 和 close 操作
- **AND** Host MUST 只省略 Usage Notification

#### Scenario: 外部 Usage Notification 与 Response 发生竞态

- **WHEN** 已接受外部 Turn 的 Usage 在 `turn/start` Response 写出之前可用
- **THEN** 通用 Host 路由 MUST 保持 response-before-notification 顺序
- **AND** Host MUST NOT 要求 Harness 专用 Response gate
