## 1. 控制合同与持久化

- [x] 1.1 扩展 Delegation 控制类型，加入 Harness inspection 输入/结果、可选 Model/Thinking Start 配置和 requested/effective 配置响应。
- [x] 1.2 复用 Mapping Store Delegation 摘要字段保存任务与配置的稳定摘要，并实现配置感知的 Request ID 冲突和隐式去重。

## 2. Harness 发现与配置验证

- [x] 2.1 在 Delegation Coordinator 中通过公共 `HarnessAdapter.inspect()` 实现外部 Harness inspection 和显式 Model/Thinking 验证。
- [x] 2.2 保持省略 Model/Thinking 时不执行人为默认填充，并将显式配置传给 `adapter.open()`。
- [x] 2.3 使用现有 external transport selection 编码持久化外部 Thread 的显式及实际配置。

## 3. 原生 Codex 支持

- [x] 3.1 通过 OfficialRequestBroker 的 `model/list` 实现原生 Codex inspection 投影。
- [x] 3.2 将显式 Model 与 Thinking/Effort 传给原生 `thread/start`，省略未指定字段并返回已确认配置。

## 4. Runtime 与 CLI

- [x] 4.1 扩展 Delegation Registry 和 loopback server，加入 Harness inspection 路由。
- [x] 4.2 实现 `codexhost harness inspect <harness> [--cwd <path>] [--refresh true|false]`。
- [x] 4.3 为 `delegate start` 增加 `--model` 与 `--thinking`，更新帮助、Launcher/npm 转发和 Delegation Skill。

## 5. 测试与验证

- [x] 5.1 添加外部 Harness inspection、默认配置保持、显式 Model/Thinking、非法组合和配置感知幂等测试。
- [x] 5.2 添加原生 Codex model/list、显式配置 thread/start、CLI、控制服务、Registry 和 AppServerHost 聚焦测试。
- [x] 5.3 运行 typecheck、lint、格式、边界、聚焦测试、Rust 检查、release smoke test 和 OpenSpec strict validation。
