# Qoder 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `qoder`；中国版 `qoder-cn` 复用实现 |
| 原生接口与传输方式 | Qoder Agent SDK；配置作用域 daemon；CLI `--sdk` 协议 |
| 已验证的原生版本 | SDK 1.0.58、海外版 CLI 1.1.81（macOS 本机模型查询） |
| 交付范围 | 现有预装插件的模型发现修复；不扩展公共契约 |
| 参考插件 | Pi、Claude Code：首次检查读取原生目录，成功结果按工作目录缓存，显式刷新重新读取 |
| 最后验证 | macOS 本机 CLI 1.1.81：隔离插件冷启动和主目录 Desktop Host 均返回 15 项，默认 Qwen3.8-Flash；完整验证见下表 |

## 能力

下表描述现有实现；测试文件是能力证据，不代表全部功能均经过真实 CLI 验收。

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | packages/host-runtime/test/installed-harness-plugins.test.ts（仓库根路径） | 两版独立身份 |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | test/qoder-variants.test.ts | 按变体选择 SDK |
| A3 | 检查 | 必做 | P0 | 支持 | src/qoder-adapter.ts | test/qoder-model-inspection.test.ts、test/qoder-adapter.test.ts | 等待 Query 初始化，live 获取目录；按工作目录缓存成功结果 |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/qoder-adapter.ts | test/qoder-adapter.test.ts、test/qoder-session-models.test.ts | 传播 Session 环境；目录按项目 cwd 获取；未显式选择 Model 时不向 CLI 强加 Model |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/qoder-sdk-transport.ts | test/qoder-adapter.test.ts | 原生消息流 |
| A6 | 取消 | 必做 | P0 | 支持 | src/qoder-sdk-transport.ts | test/qoder-lifecycle.test.ts | 等待原生结果后解除忙碌 |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/qoder-history.ts、src/qoder-sdk-transport.ts | test/qoder-history.test.ts | 不提交 Prompt |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/qoder-adapter.ts | test/qoder-adapter.test.ts | 两版身份隔离 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/qoder-errors.ts、src/qoder-sdk-transport.ts | test/qoder-lifecycle.test.ts | 类型化失败、活动 Turn 互斥 |
| A10 | 关闭 | 必做 | P0 | 支持 | src/qoder-adapter.ts、src/qoder-daemon-pool.ts | test/qoder-sdk58-compat.test.ts、test/qoder-session-models.test.ts | daemon 引用计数释放；取消并排空在途模型检查 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/qoder-models.ts、src/qoder-sdk-transport.ts | test/qoder-adapter.test.ts | 选择结果由原生接口确认 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/qoder-models.ts、src/qoder-sdk-transport.ts | test/qoder-adapter.test.ts | 使用原生模型的 effort 信息 |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/qoder-permission-modes.ts、src/qoder-sdk-transport.ts | test/qoder-sdk58-compat.test.ts | Plan 使用独立原生接口 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/qoder-adapter.ts | test/qoder-lifecycle.test.ts | 映射 bypassPermissions，拒绝冲突 |
| B5 | Fork | 原生有则必做 | P1 | 支持 | src/qoder-adapter.ts | test/qoder-adapter.test.ts | 原生 SDK forkSession |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 受限 | src/qoder-adapter.ts | test/qoder-adapter.test.ts | forkAcrossCwd 为 false |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 支持 | src/qoder-adapter.ts | test/qoder-adapter.test.ts | 派生保留前缀 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/qoder-sdk-transport.ts、src/qoder-slash-commands.ts | test/qoder-tool-items.test.ts、test/slash-commands.test.ts | 复用公共工具投影 |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/qoder-sdk-transport.ts | test/qoder-adapter.test.ts | canUseTool 回调 |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | src/qoder-sdk-transport.ts | test/qoder-adapter.test.ts | AskUserQuestion 交互 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 待验证 | src/qoder-sdk-transport.ts | — | 未声明完整 Subagent 能力 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 待验证 | src/qoder-sdk-transport.ts | — | 未声明自主 Turn 能力 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/qoder-usage.ts | test/qoder-adapter.test.ts | 原生上下文及 usage |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | src/qoder-sdk-transport.ts | — | 不以会话总量冒充单请求计量 |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/qoder-adapter.ts | test/qoder-lifecycle.test.ts、test/qoder-sdk58-compat.test.ts | 已覆盖执行策略和线程环境；真实委派未验收 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | src/qoder-adapter.ts | — | CLI 发现及真实执行未验收 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、assets/icon.svg | packages/host-runtime/test/installed-harness-plugins.test.ts（仓库根路径） | 名称、图标、链接 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | packages/host-runtime/test/installed-harness-plugins.test.ts（仓库根路径） | Shell / PowerShell |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts | test/installation.test.ts | 原生更新器 |
| C4 | 首次安装 | 可选 | P2 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts（仓库根路径） | 公共安装器 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | src/qoder-command.ts、src/plugin.ts | test/qoder-variants.test.ts | 每版独立命令覆盖 |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/qoder-session-import.ts | test/qoder-session-import.test.ts | 原生 SDK 发现与重新读取 |
| C7 | 全局用量统计 | 可选 | P2 | 支持 | src/qoder-usage-statistics.ts | test/qoder-usage-statistics.test.ts | 本地原生存储只读 |
| C8 | 账号额度 | 可选 | P2 | 支持 | src/qoder-account.ts、src/qoder-adapter.ts | test/account.test.ts | 探测结束关闭 Query |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json | 根 package.json 的 build:typescript | SDK 依赖固定版本 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json（仓库根路径） | packages/host-runtime/test/installed-harness-plugins.test.ts（仓库根路径） | qoder / qoder-cn |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | packages/host-runtime/test/installed-harness-plugins.test.ts（仓库根路径） | 真实插件 Loader |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/architecture/harness-plugin-runtime.md（仓库根路径） | 模型目录与缓存说明 | 两版共用规范 |
| D5 | 其他 | 可选 | P2 | 不适用 | — | — | 不增加产品入口 |

## 受限与已知缺口

- A3：完整目录先等待 Query 初始化，再通过一次 SDK live 查询获取，两步共用 10 秒预算，不重试；availability 使用相同检查路径。普通读取复用 Adapter 缓存；显式刷新重新查询，迟到的旧结果不覆盖新缓存。无 cwd 的检查与显式项目目录不共享缓存；open 按 input.cwd 获取目录，未显式选择 Model 时报告其原生默认值但不传 model 给 CLI。
- B6：仅支持同工作目录 Fork。
- B11、B12、B14、B16：不属于模型发现修复的验证范围，不能据此宣称完整支持。
- B15：原生真实委派链路尚未验收。
- 空目录如实保留；不伪造默认模型，不根据 `isEnabled` 修改 SDK 返回的目录及顺序。

## 插件外改动

- `docs/architecture/harness-plugin-runtime.md`：保持模型发现策略与实现一致。不修改 Host、Renderer 或公共契约。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 | `npx vitest run --config tests/vitest.config.js packages/adapters/qoder/test packages/host-runtime/test/installed-harness-plugins.test.ts` | 203 项通过；1 项依赖 OpenCode 原生命令配置的检查跳过；含两版模型发现回归 |
| 原生边界 | SDK 1.0.58 + CLI 1.1.81；冷 Query 的初始化与模型查询 | 未等初始化时 live 仍可返回空目录；等待初始化后 live 返回 15 项 |
| 插件加载 | 复制海外版 bundle 至临时隔离根，通过 `loadHarnessPlugins` 加载并检查 | 首次 15 项；普通读取复用同一结果；显式刷新重新得到 15 项；检查结束关闭 Registry |
| Host 集成 | 主目录 Desktop 重启后，通过其控制通道调用 `codexhost/harness/inspect` | 普通检查与显式刷新均 ready、15 项、默认 Qwen3.8-Flash；Renderer 安装状态 installed、无失败 |
| 真实原生验收 | macOS、海外版、本机 CLI 登录、默认 Qwen3.8-Flash；模型发现，不提交 Prompt | 冷启动及刷新通过；不包含实际对话、中国版原生 CLI 或 SSH |
| Desktop / 委派 | Desktop 可见模型选择 / 真实委派 | 未操作模型选择或发送对话；真实委派未验收 |
| 静态检查 | `npm run build:typescript`、`npm run typecheck` | 通过 |
| Session 目录与检查生命周期 | `npx vitest run --config tests/vitest.config.js packages/adapters/qoder/test` | 192 项通过；含不同于 Host cwd 的项目、原生默认 Model、共享超时预算、关闭取消及刷新竞态 |
| 聚焦静态检查 | `npm run typecheck`、`npx eslint packages/adapters/qoder`、修改文件的 Prettier 检查 | 隔离 worktree 按 lockfile 安装依赖后通过；未新增原生 CLI 或 Desktop 手工验收 |
