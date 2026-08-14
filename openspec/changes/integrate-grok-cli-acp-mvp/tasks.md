## 1. Grok ACP Adapter

- [x] 1.1 新增 `packages/adapters/grok`、ACP SDK 依赖和 Grok 可执行文件解析，完成 initialize、create/load、prompt/cancel、close 与错误分类
- [x] 1.2 将 ACP Text、Thinking、Tool、Permission 和 terminal 映射到现有 HarnessSession，并实现 Model/Thinking capability 探测和可靠 Usage 映射
- [x] 1.3 实现恢复 Snapshot 的最小路径；优先使用 ACP load 回放，身份不足时只读 Grok `updates.jsonl`，并保持 Fork/Rollback/Diff 降级

## 2. Host 路由

- [x] 2.1 在 Protocol Core 增加 `grok` 和 `codexhost/grok-native` carrier，并在生产组合、构建和发布中注册 GrokAdapter
- [x] 2.2 通过现有通用 External Thread 路径验证 Grok create、Turn、cancel、read、resume、inspection、Usage 和 close，不在 Host Runtime 增加 ACP/Grok 事件分支

## 3. Renderer

- [x] 3.1 在 Agent Picker、图标、安装链接和 Composer 状态中增加 Grok，并复用现有 capability-driven Model、Thinking、Permission 和 Usage 控件
- [x] 3.2 保持 Grok 配置偏好与 Pi/Claude Code 隔离，并在 Grok unavailable 或不支持历史操作时沿用现有 fail-closed UI

## 4. 最小验证

- [x] 4.1 添加一个 ACP Transport fixture 测试和一个 Grok Adapter 聚焦测试，覆盖核心事件、Approval、Cancel、capability 降级和 resume Snapshot
- [x] 4.2 运行受影响 TypeScript typecheck/聚焦测试与 OpenSpec validate；显式执行一次不进入默认测试的真实 Grok 合成 Prompt 冒烟验证并只记录 pass/fail
