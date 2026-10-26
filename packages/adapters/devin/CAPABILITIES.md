# Devin CLI 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `devin` |
| 原生接口与传输方式 | `devin acp` stdio，`@agentclientprotocol/sdk` |
| 已验证的原生版本 | PR 原生记录：3000.10.31；3000.11+ 认证适配见 `src/credentials.ts`，本地未复验 |
| 交付范围 | 预装插件；Desktop 与完整委派验收尚未完成 |
| 参考插件 | Qoder 的执行策略冲突拒绝；Pi 的历史边界、独立 Fork、Rollback 配置保留及测试结构（不复用其协议或存储）；公共插件 Loader |
| 最后验证 | 本地 macOS 无 Devin CLI；仅 hermetic 测试，不代表原生验收 |

证据路径相对于插件目录；[集成记录](../../../docs/harnesses/devin/devin-cli-acp-integration.md)保留 PR 的原生实测范围。Host 测试位于仓库根 `packages/host-runtime/test/`。

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | Host installed-harness-plugins.test.ts | 公共插件 schema |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | Host installed-harness-plugins.test.ts | 独立 Adapter |
| A3 | 检查 | 必做 | P0 | 受限 | src/adapter.ts | test/devin-adapter.test.ts | 目录检查创建空原生 Session |
| A4 | 创建 Session | 必做 | P0 | 受限 | src/adapter.ts | 集成记录；test/devin-adapter.test.ts | 预热空会话持久化未验证 |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/adapter.ts | test/devin-adapter.test.ts；集成记录 | 文本输入 |
| A6 | 取消 | 必做 | P0 | 受限 | src/adapter.ts | test/devin-adapter.test.ts | 取消后原生恢复待实测 |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/projection.ts | test/devin-adapter.test.ts；集成记录 | 同连接 load 回放 |
| A8 | 持久身份 + resume | 必做 | P0 | 受限 | src/projection.ts、src/adapter.ts | test/devin-adapter.test.ts；集成记录 | 压缩与取消历史未验证 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/adapter.ts | test/devin-adapter.test.ts、test/configuration.test.ts | 活动 Turn 与并行配置边界 |
| A10 | 关闭 | 必做 | P0 | 支持 | src/transport.ts、src/adapter.ts | test/devin-adapter.test.ts | 结束流及子进程 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/adapter.ts、src/models.ts | test/configuration.test.ts | 活动 Turn 直接调用原生 config，确认后发布状态 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 不支持 | src/models.ts | 集成记录：无独立 selector | 返回 unsupported |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/models.ts、src/adapter.ts | test/devin-adapter.test.ts | 原生确认后更新 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 受限 | src/adapter.ts | test/configuration.test.ts；原生 modes 目录含 bypass | 创建前拒绝非 bypass；真实工具执行未验收 |
| B5 | Fork | 原生有则必做 | P1 | 待验证 | src/models.ts、src/adapter.ts | 官方 `/fork [step]`；集成记录「History derivation」；test/history.test.ts | 精确边界调用与返回契约不足；保持 false，open 返回 unsupported |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 待验证 | src/models.ts、src/adapter.ts | 同 B5；test/history.test.ts | 原生目标 cwd 未验证；保持 false |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 待验证 | src/models.ts、src/adapter.ts | 官方 `/revert` 撤销文件，不符合 Host 语义；test/history.test.ts | 依赖精确 Fork 与当前配置保留；保持 false，open 返回 unsupported |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/projection.ts | test/devin-adapter.test.ts | 工具、推理、diff |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/interactions.ts | test/devin-adapter.test.ts | 原生 options 精确关联 |
| B10 | 提问 | 原生有则必做 | P0 | 受限 | src/interactions.ts | extension() 显式失败 | 未映射 Devin 阻塞扩展 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 待验证 | — | 集成记录列为未接入 | 不声明能力 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 待验证 | — | 未有原生实测依据 | 不声明能力 |
| B13 | 会话用量 | 原生有则必做 | P1 | 待验证 | src/adapter.ts | initialUsage 为 null | 未接入 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | — | 未有原生计量证据 | 不发送 usage 事件 |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/adapter.ts | environment 合并与 bypass 映射 | 完整委派未实测 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | — | 未实测 CLI 发现与调用 | 不宣称支持 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、assets/icon.svg | Host installed-harness-plugins.test.ts | 动态目录 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | 安装命令与登录指引 | macOS/Linux/Windows |
| C3 | 版本检查与更新 | 必做 | P1 | 受限 | src/plugin.ts | 工厂未提供 installation() | 必做缺口，未实现 |
| C4 | 首次安装 | 可选 | P2 | 不支持 | manifest.json | 仅提供原生安装脚本指引 | 无一键安装 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 受限 | src/command.ts | CODEXHOST_DEVIN_COMMAND | 无连接页路径设置 |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/import.ts | test/devin-adapter.test.ts | sessionless list |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | — | 未接入 | 不声明能力 |
| C8 | 账号额度 | 可选 | P2 | 不支持 | src/adapter.ts | 集成记录：auth status 无有效额度百分比 | 不伪造额度 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json | 根构建配置 | ESM bundle |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json（仓库根） | 发布插件列表 | devin |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | Host installed-harness-plugins.test.ts | 真实 Loader |
| D4 | 文档 | 预装时必做 | P1 | 受限 | 集成记录 | docs/index.md | 产品能力总表尚未补全 |
| D5 | 其他 | 可选 | P2 | 待验证 | — | Desktop 未实测 | 无专有 Renderer 分支 |

## 受限与已知缺口

- A3/A4：inspect 调用 session/new 获取目录；原生空 Session 的持久化和预热丢弃行为未验证，不能宣称满足无用户会话副作用要求。
- A6/A8：已有取消与身份回放 mock 测试；真实取消后继续、压缩历史、重载持久性尚未验证。
- B1/B4：活动 Turn 配置和无人值守显式权限冲突由 hermetic 回归测试覆盖；真实运行中切换及 bypass 工具执行仍需 CLI 验收。
- B5–B7：官方交互命令和 changelog 表明原生有 Fork/revert，不能据旧版 ACP 探测认定原生不支持。SDK 1.3.0 的实验性 session/fork 没有精确边界字段；Devin 的 step 与 Host Turn 对齐、命令分发、派生身份、历史回放和配置保留尚无充分协议依据。P1 历史能力未完成；验收清单和脱敏证据要求见集成记录「History derivation」。不得使用会撤销文件的 `/revert` 实现 Host rollback。
- B10：未映射的扩展明确报错，不自动代答；原生提问协议需进一步核实。
- B11–B16/C7：未验证的原生能力不等于原生不支持；完整委派、用量、自主 Turn、Subagent 不作完成声明。
- C3：缺少版本检查与更新，仍是 P1 交付缺口。C5 仅支持环境变量命令覆盖。
- D4/D5：集成记录和插件清单不替代完整产品文档与 Desktop 验收。

## 插件外改动

- 根 `tsconfig.json`、`package-lock.json`：Workspace 构建和依赖。
- `scripts/release/harness-plugins.json`：预装清单。
- `packages/host-runtime/test/installed-harness-plugins.test.ts`：插件加载断言。
- `packages/renderer-extension/test/settings/pages.test.ts`：连接页链接断言。
- `docs/harnesses/devin/devin-cli-acp-integration.md`、`docs/index.md`：集成文档和导航。
- 没有新增 Harness 专用的 Host 或 Renderer 生产分支。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 | Vitest，`tests/vitest.config.js`，`packages/adapters/devin/test` | 32 项通过；配置回归 14 项中 9 项在修复前失败 |
| 历史能力边界 | Vitest 聚焦 `test/history.test.ts`、`test/devin-adapter.test.ts`、`test/configuration.test.ts` | 36 项测试通过（历史边界 4 项）；仅验证能力关闭、无原生启动及不伪造 checkpoint，不代表原生 Fork/rollback 验收 |
| 原生边界 | Mock ACP 回放、权限和终态 | 非真实 CLI 验收 |
| 插件加载 | installed-harness-plugins.test.ts | 与 Devin、host-bundle 聚焦检查合计 64 项通过、1 项跳过；跳过的是未配置 CODEXHOST_OPENCODE_REAL_COMMAND 的原生测试 |
| Host 集成 | typecheck、build:typescript、lint | 通过；turn.steer 显式返回 unsupported |
| 真实原生验收 | PR 集成记录中的 3000.10.31 / macOS / swe-2-high / accept-edits | 历史记录；本机无 CLI，未复验 |
| Desktop / 委派 | — | 未执行 |
