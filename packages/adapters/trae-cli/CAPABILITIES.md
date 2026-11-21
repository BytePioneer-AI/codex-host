# TRAE CLI (ACP) 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `trae-cli` |
| 原生接口与传输方式 | 官方 `traecli acp serve` / stdio ACP 1 |
| 已验证的原生版本 | Windows CLI 0.213.1：握手及未登录错误；未获 CLI 权限 |
| 交付范围 | 实验性仓库插件及预装接线；PR 保留草稿；未部署日常 Desktop |
| 参考插件 | Devin 的 stdio 生命周期及 ACP 配置；Kimi 的 form/config 思路；未复制其私有协议 |
| 最后验证 | 2026-11-17 / Windows / 无授权账号；原生握手与独立协议子进程测试 |

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | Manifest schema / Loader | 与 API 1 公共契约一致 |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | 真实 Loader / 工厂隔离 | 不启动自动登录或更新 |
| A3 | 检查 | 必做 | P0 | 受限 | src/adapter.ts | 原生握手与 Authentication required；协议测试 | 无 Session/Prompt 副作用；成功目录缓存到 refresh |
| A4 | 创建 Session | 必做 | P0 | 受限 | src/adapter.ts；src/session.ts | 协议子进程：延迟创建和环境覆盖 | 真实账号创建待验收；显式配置可创建空 Session |
| A5 | 执行 Turn | 必做 | P0 | 受限 | src/session.ts；src/projection.ts | 协议子进程：流式消息、工具、Diff | 真实推理待授权账号验收 |
| A6 | 取消 | 必做 | P0 | 受限 | src/session.ts | 协议子进程：运行中及创建中取消、后续轮次 | 原生账户取消与持久历史待验证 |
| A7 | 只读快照 | 必做 | P0 | 受限 | src/projection.ts；src/session.ts | 稳定身份重读与截断拒绝测试 | 原生 replay 无 stop reason 时保留 unknown |
| A8 | 持久身份 + resume | 必做 | P0 | 受限 | src/adapter.ts；src/transport.ts | 跨进程 load / 已知 Turn 校验 | 实测握手上报 load；真实两轮冷恢复待验证 |
| A9 | 错误与并发 | 必做 | P0 | 受限 | src/common.ts；src/session.ts | 未安装、无认证、忙碌、原生退出、超时测试 | 无不确定输入重发 |
| A10 | 关闭 | 必做 | P0 | 受限 | src/transport.ts | 独立子进程退出及幂等关闭测试 | 真实 CLI 活动任务/daemon 生命周期待授权验收 |
| B1 | 切换 Model | 原生有则必做 | P1 | 受限 | src/configuration.ts；src/session.ts | 完整 configOptions 确认和运行中切换测试 | 真实账号目录及选项名称待验证 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 受限 | src/configuration.ts；src/session.ts | Model 更换清除旧 Thinking；原生配置确认测试 | 只暴露 Session 上报 thought_level；无静态档位 |
| B3 | 权限模式 | 原生有则必做 | P1 | 受限 | src/session.ts | 原生 modes 列表与 set_mode 读回测试 | 运行中拒绝修改；不写全局配置 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 受限 | src/adapter.ts | unattended-full-access 无副作用拒绝测试 | 权限等价性未证实，明确 unsupported |
| B5 | Fork | 原生有则必做 | P1 | 受限 | src/adapter.ts | 公开操作明确 unsupported | 原生握手有全会话 fork；未证明精确 checkpoint 语义 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 不支持 | src/configuration.ts | capability false | 跨目录 Fork 不声明 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 受限 | src/adapter.ts | 公开操作明确 unsupported | CLI 原生相关能力不等于可无损组合 Host Rollback |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 受限 | src/projection.ts | 工具 rawInput、输出及 ACP diff 内容测试 | 不伪造 command exit code 或实际磁盘回滚 |
| B9 | 审批 | 原生有则必做 | P0 | 受限 | src/interactions.ts | allow/deny、foreign/stale response 测试 | 真实审批安全策略待验收 |
| B10 | 提问 | 原生有则必做 | P0 | 受限 | src/interactions.ts | 字符串/枚举 form 回传测试 | 复杂字段约束、URL form 明确拒绝；真实 CLI 待验收 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 待验证 | — | 无授权原生依据 | 不宣称原生 Subagent 接入 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 待验证 | — | 无原生自主轮次执行证据 | 不隐藏发送普通 Prompt 模拟自主运行 |
| B13 | 会话用量 | 原生有则必做 | P1 | 待验证 | — | initialUsage=null | 不从桌面或估值填用量 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | — | 无原生计量样本 | 不伪造计费 |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | 公共 HarnessAdapter 接口 | 协议普通会话可执行；无人值守拒绝 | 完整 Coordinator 与真实委派待授权账号验收 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | — | 无真实 CLI 工具子进程验证 | Thread env 已覆盖到原生进程；不据此宣称完整递归委派 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json；assets/icon.svg | Manifest schema / Loader | 展示为 TRAE CLI，与旧 trae-cn 不同 ID |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | 官方安装和账号限制文档 | 不安装 Companion / 不改用户登录 |
| C3 | 版本检查与更新 | 必做 | P1 | 受限 | src/plugin.ts | 官方 --version 及工厂测试 | 更新为手动 traecli update；未捏造 latestVersion |
| C4 | 首次安装 | 可选 | P2 | 不适用 | — | 提供官方手动安装指引 | 不增加未经验证自动安装器 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | src/command.ts | 自定义 .cmd 路径含空格的真实子进程测试 | CODEXHOST_TRAE_CLI_COMMAND 优先于 PATH |
| C6 | 会话导入 | 可选 | P2 | 待验证 | — | 不提供 sessionImport 接口 | 标准 list 能力不自动意味着可无损导入 |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | — | 无全局统计原生依据 | 不提供空实现 |
| C8 | 账号额度 | 可选 | P2 | 待验证 | — | 未获账号权限 | 不读取/复制桌面额度 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json；tsconfig.json | TypeScript / 可搬移插件构建 | 仅新增插件和发行接线 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json | 预装集合 Loader | 无 Companion 附件依赖；CLI 需单独安装认证 |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | packages/host-runtime/test/installed-harness-plugins.test.ts | 真实 Loader / 目录搬移 / 工厂隔离 | 不只直接 new Adapter |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/trae-cli/trae-cli-acp-integration.md | 能力边界与验证范围已列出 | README 保留实验性说明，不增加已验收勾号 |
| D5 | 其他 | 可选 | P2 | 待验证 | — | 真实 ACP 登录后全流程待补 | 保持 draft，不把夹具当原生验收 |

## 受限与已知缺口

- 没有可用 CLI 账号权限。仅实测 0.213.1 的 initialize、未认证 list/new 错误与空 `models --json`；登录后目录 schema、模型/Agent 与桌面/SOLO 的关系均未实测。不能把协议夹具或标准 ACP 字段称为真实原生模型证据。
- 具体支持及待验收项见接入文档。Draft 保留：真实推理、权限/审批/提问、冷恢复、原生关闭语义和空 Session 清理。
- Replay 不保证 native message IDs 或历史终态。使用用户边界位置与输入摘要作为稳定键，并校验已知前缀；相邻无回复用户消息可能无法可靠区分，遇到不一致就拒绝，不伪造恢复成功。
- 不广告精确 Fork/Rollback、Steering、无人值守、Subagent、递归委派或未观察到的 Usage。

## 插件外改动

- `tsconfig.json`、`package-lock.json`：新增 Workspace 构建及本地链接。
- `scripts/release/harness-plugins.json`：独立 CLI 插件预装清单，不引入 Companion。
- `packages/host-runtime/test/installed-harness-plugins.test.ts`：集合及显式命令覆盖测试。
- `docs/index.md`、`docs/harnesses/capability-boundaries.md`、`README.md`、`docs/project/README.zh-CN.md`、`docs/project/README.ko.md`：实验性入口与能力说明。
- 无 Host/Renderer/protocol-core/shared-contracts 生产代码改动。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 / 协议边界 | 聚焦 `test/acp.test.ts`，独立 Node ACP 子进程 | 19 项分批验证通过；独立协议进程，没有模拟 Adapter/Transport |
| 原生边界 | 官方 CLI 0.213.1 initialize / list / new / models --json | initialize 成功；list/new 明确 Authentication required；models 空列表 |
| 插件加载 / Host 集成 | 构建预装集合与真实 Loader；搬移目录、并发工厂、显式命令覆盖 | 29 项通过、1 项既有测试跳过（OpenCode 真实 CLI 用例未设置 CODEXHOST_OPENCODE_REAL_COMMAND）；真实 Loader 验证通过 |
| 真实原生验收 | Windows；账号无 CLI 权限 | 未完成：不宣称登录后对话和配置能力通过 |
| Desktop / 完整委派 | 未部署日常 Desktop；无权限原生账号 | 待验证；无人值守明确拒绝 |