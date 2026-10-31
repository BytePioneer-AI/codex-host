# Trae CLI 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | trae |
| 原生接口与传输方式 | 官方 CLI `traecli app-server --stdio`，JSON-RPC；不连接 IDE 私有接口 |
| 已验证的原生版本 | public 0.213.1；由 CLI 的 `app-server generate-ts` 导出协议核对 |
| 交付范围 | 仓库内预装插件，Desktop 通过公共插件目录接入 |
| 参考插件 | Kiro 的可执行文件发现；ZCode 的进程生命周期；公共 Harness 契约 |
| 最后验证 | 2026-10-31 Windows；原生未登录，已验证 initialize/account/read/model/list |

## 能力

清单在编码前建立，下表记录当前交付边界。「受限」表示接口已实现并有原生协议模拟进程测试，但真实账号下的运行仍未验收；不把原生握手成功或协议测试当成真实对话成功。

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | installed-harness-plugins.test.ts、真实 Loader | |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | 预装 Loader + 移出仓库的 Bundle | 独立实例 |
| A3 | 检查 | 必做 | P0 | 受限 | src/adapter.ts、src/connection.ts | adapter.test.ts；真实 CLI 返回 authenticationRequired | 不创建 Session；成功目录需登录验收 |
| A4 | 创建 Session | 必做 | P0 | 受限 | src/session.ts | adapter.test.ts lazy create | 首轮前无 Thread |
| A5 | 执行 Turn | 必做 | P0 | 受限 | src/session.ts | adapter.test.ts Unicode、提前通知、唯一终态 | 真实推理待验收 |
| A6 | 取消 | 必做 | P0 | 受限 | src/session.ts | adapter.test.ts 延迟 interrupted，随后可继续 | 不以 RPC ack 冒充取消完成 |
| A7 | 只读快照 | 必做 | P0 | 受限 | src/projection.ts | adapter.test.ts、projection.test.ts | 拒绝不完整 itemsView；原生未持久化内容无法补造 |
| A8 | 持久身份 + resume | 必做 | P0 | 受限 | src/history.ts、src/session.ts | app-server-host.trae.test.ts 重启后继续同一身份 | 原生状态优先 |
| A9 | 错误与并发 | 必做 | P0 | 受限 | src/transport.ts、src/session.ts | adapter.test.ts 空输入、拒绝、并发、崩溃、错交互 | 不回显 stderr/原生错误文本 |
| A10 | 关闭 | 必做 | P0 | 受限 | src/transport.ts、src/session.ts | adapter.test.ts 幂等关闭、待初始化、待交互 | Windows 协议进程已测试；真实工具树/其他 OS 待验收 |
| B1 | 切换 Model | 原生有则必做 | P1 | 受限 | src/session.ts | adapter.test.ts draft、运行中选择、确认失败 | 草稿不发布 effective |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 受限 | src/session.ts | adapter.test.ts；原生导出 config model_reasoning_effort | 不支持组合拒绝 |
| B3 | 权限模式 | 原生有则必做 | P1 | 受限 | src/configuration.ts | projection.test.ts、adapter.test.ts native ack | workspace-write 为插件默认；未确认不当成生效 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 受限 | src/session.ts | adapter.test.ts full access、冲突、忽略权限后的重复拒绝 | never + danger-full-access；每轮前确认 |
| B5 | Fork | 原生有则必做 | P1 | 受限 | src/history.ts | adapter.test.ts 精确边界与错误边界拒绝 | 验证输入、Item、终态、源历史不变 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 受限 | src/history.ts | 原生 thread/fork cwd；回执核对目录 | 真实跨目录待验收 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 受限 | src/history.ts | adapter.test.ts Fork 副本 + thread/rollback | 不修改源历史，不回滚工作区文件 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 受限 | src/projection.ts | projection.test.ts 原生命令输出、diff、工具和压缩 | 后台命令明确 fault/停止，不能伪报完成 |
| B9 | 审批 | 原生有则必做 | P0 | 受限 | src/interactions.ts | adapter.test.ts approval 回传/错误/重复/关闭 | allow once/session、deny |
| B10 | 提问 | 原生有则必做 | P0 | 受限 | src/interactions.ts | adapter.test.ts question 回传 | 选择/文本/多选；原生取消为客户端错误 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 不支持 | — | app-server 有 collabAgentToolCall，独立子会话读取未接入 | P2；以工具保留结果 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/session.ts | adapter.test.ts 原生自主轮唯一生命周期 | 真实后台事件待验收 |
| B13 | 会话用量 | 原生有则必做 | P1 | 受限 | src/projection.ts | adapter.test.ts、projection.test.ts 聚合 tokenUsage | 缺失字段省略、无虚构费用 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 不支持 | — | 原生聚合 tokenUsage 不能归为单次请求 | 不虚构费用 |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/session.ts | app-server-host.trae.test.ts 公共 Coordinator start/read/restart/send | 协议/打包层完成；真实委派待登录 |
| B16 | 向下委派 | 原生有则必做 | P2 | 不支持 | — | 环境已传播，但未接入并实测 CLI 发现 | 不宣称递归委派 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json | 预装 Loader 图标/Manifest 加载 | |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | 官方 CLI 2.0 指引、命令和登录步骤 | |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts | adapter.test.ts --version、拒绝自动更新 | latestUnknown + 原安装手动更新，不替换另一份安装 |
| C4 | 首次安装 | 可选 | P2 | 不支持 | — | 使用官方安装指引 | |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | src/command.ts | CODEXHOST_TRAE_COMMAND | 独立 CLI，不使用应用目录设置 |
| C6 | 会话导入 | 可选 | P2 | 不支持 | — | 仅恢复已映射 Thread；不扫描 IDE 数据库 | |
| C7 | 全局用量统计 | 可选 | P2 | 不支持 | — | 未接入全局统计 | |
| C8 | 账号额度 | 可选 | P2 | 不支持 | — | 未接入额度；认证只读 account/read | |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json | TypeScript + ESM 插件构建 | 无额外 SDK 依赖 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json | 预装加载与 Bundle 测试 | 不静态注册 |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | host-runtime/test/app-server-host.trae.test.ts | 临时根 Loader + 委派 + Host 重启 | 不使用手工 Adapter 替身 |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/trae/trae-harness-integration.md | docs/index.md、README、能力边界同步 | |
| D5 | 其他 | 可选 | P2 | 不适用 | — | 使用公共路由 | |

## 受限与已知缺口

- Trae CLI 的 app-server 是官方实验性接口；只对记录的版本验证，不推断与 Codex 或其他 fork 的协议兼容。
- 当前本机 CLI 未登录，不能宣称已完成账号权限下的真实推理验收。
- 不读取或移植 TRAE IDE / SOLO 的登录令牌，不将开源 Python trae-agent 冒充此 CLI。
- P2 Subagent、请求计量、导入、递归委派与账号额度不在此适配中声明。
- 后台命令不能跟踪最终退出；遇到 backgrounded 明确停止并报 unsupported。只保证前台命令语义。

## 插件外改动

仅构建引用、预装清单、lockfile、加载测试和受影响文档；不增加 Host / Renderer 的 Trae 专用分支。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| 原生边界 | public 0.213.1 --version、app-server generate-ts、initialize/account/read/model/list | 成功；未登录；模型池为空 |
| Adapter / 原生模拟进程 / 加载 / Bundle | Trae 聚焦测试、installed-harness-plugins、app-server-host.trae、host-bundle | 58 passed，1 skipped（既有可选 OpenCode live test） |
| 静态检查 | build:typescript、typecheck、lint、改动文件 Prettier、git diff --check | 通过 |
| Payload | npm exec -- vitest run --config tests/vitest.config.js tests/release/payload.test.mjs | 8 passed；符号链接拒绝测试在 Windows 创建链接时 EPERM，未绕过 |
| Desktop / 真实推理 / 委派 | 需要 CLI 登录和对应模型权限 | 待验证 |
