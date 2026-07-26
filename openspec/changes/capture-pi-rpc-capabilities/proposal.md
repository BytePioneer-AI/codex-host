## Why

codexhost 的公开 MVP 要求 Pi 真正拥有 Agent Loop、Native Session、工具、交互、取消、历史和 Fork，但这些能力在用户本机 Pi 的官方 RPC 上尚未通过本仓代码形成可重复证据。在定义 Shared Contracts、HarnessAdapter 实现和 PiAdapter 之前，需要先用能力驱动、与 Harness 版本无关的 Gate C 验证关闭关键协议和生命周期风险。

## What Changes

- 建立开发专用 Pi RPC Capture，通过可注入命令、`PI_COMMAND` 或默认 `pi` 启动用户本机可执行程序，并追加 `--mode rpc` 等受控参数。
- 不读取、记录、比较或限制 Pi/Harness 版本；只根据实际 RPC 响应、事件和行为判定能力。
- 实现严格 LF JSONL 分帧、请求关联、异步事件接收、stderr 隔离、背压、EOF、超时和有界进程清理的 Gate 客户端及 hermetic 测试。
- 在隔离工作目录和独立 Native Session 中采集流式消息、Tool、成功 Edit Patch、Question、取消、错误、历史、Model 切换、Native Turn Ref 候选、Checkpoint、Fork/Clone 和无 Agent Loop Command 证据。
- 允许显式加载受控 Gate Extension 构造 Question 和无 Agent Loop 场景，但不据此承诺生产环境注入 Extension，也不把通用 `confirm` 推断为 Approval。
- 将真实 Capture、Native Session、能力矩阵和 Gate 报告留在忽略目录；仓库只提交 Fake Pi 生成的确定性合成 Fixture 和自动化断言，不实现真实证据脱敏或提交流程。
- 根据实际证据修正开发步骤和相关技术设计中的不准确假设；证据不足时保留为未决问题，不固化正式 Host 或 Adapter 契约。
- 本变更不实现正式 PiAdapter、HarnessAdapter、Shared Contracts、Protocol Core、Renderer、Mapping Store、ACP、Pi SDK 接入或产品打包。

## Capabilities

### New Capabilities

- `pi-rpc-capability-probe`: 定义与 Harness 版本无关的 Pi RPC 启动、传输、生命周期、Session、Tool、Interaction、历史、Model、Fork、本地证据和 Gate 判定要求。

### Modified Capabilities

无。

## Impact

- 主要影响 `tools/gate-c/`、Fake Pi 合成 Fixture、Gate 专用测试、根工程命令和本地 Pi RPC 验证记录。
- 允许按证据修正 `docs/开发步骤清单.md`、`docs/技术架构设计文档.md` 和 `docs/HarnessAdapter技术设计文档.md`，但不提前扩大公共接口。
- 与用户本机可执行的 Pi、其 Native Mode 配置、Provider、认证和 Native Session 交互；真实模型场景必须显式运行，不进入普通 `npm run check`。
- 不引入 Harness 版本字段、版本探测、版本门禁、ACP 兼容层或 Pi npm SDK 依赖。
