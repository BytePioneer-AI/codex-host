# Claude Code 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `claude-code` |
| 原生接口与传输方式 | Agent SDK Query、原生 Session API、只读 JSONL transcript；受管 macOS 远端经 Broker |
| 已验证的原生版本 | 历史样本为 CLI 2.1.319；SDK 依赖 0.3.273。其他版本的既有验收见 steer 文档 |
| 交付范围 | 现有预装插件的冷历史修复；不发布、不替换已安装插件 |
| 参考插件 | 复用本插件历史、Fork 前缀校验与公共 HostUserMessageItem，不新增传输层 |
| 最后验证 | 2026-11-09 macOS；Haiku 4.5、现有认证；本次只读既有测试 Session，不发送任务 |

“既有测试”指可定位的仓库测试定义，不表示本次已执行；本次执行结果单列于验证记录。

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | Manifest 与 plugin.ts 的 claude-code 身份 | 本次不改发行元数据 |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | test/plugin-warmup.test.ts | 保留受管远端 Broker 分支 |
| A3 | 检查 | 必做 | P0 | 支持 | src/claude-code-adapter.ts | 原生 inspect ready；test/model-catalog.test.ts | 检查不发 Prompt |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/claude-code-adapter.ts、pending-session.ts | test/claude-code-adapter.test.ts | 原生延迟建 Session |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/claude-code-adapter.ts、sdk-transport.ts | 既有 Haiku 实机；test/claude-code-adapter.test.ts | 本次不新增执行路径 |
| A6 | 取消 | 必做 | P0 | 受限 | src/claude-code-adapter.ts、process-fence.ts | test/claude-code-adapter.test.ts | 有原生确认及超时升级，版本相关路径未全部实测 |
| A7 | 只读快照 | 必做 | P0 | 受限 | src/claude-history.ts、claude-transcript.ts、claude-queued-command.ts | test/claude-queued-history.test.ts、claude-history.test.ts、claude-transcript.test.ts；默认 Adapter 回放三份 2.1.319 原生样本 | queued_command 恢复见历史文档；无 Result 时 outcome 为 unknown |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/claude-code-adapter.ts、pending-session.ts | test/claude-code-adapter.test.ts | Turn 使用原生 root UUID，非每次读取重建身份 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/claude-code-adapter.ts | test/claude-code-adapter.test.ts | sessionBusy / invalidState / protocolError |
| A10 | 关闭 | 必做 | P0 | 支持 | src/sdk-transport.ts、claude-code-adapter.ts | test/sdk-transport.test.ts、claude-code-adapter.test.ts | 本次不改进程生命周期 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/model-catalog.ts、claude-code-adapter.ts | inspect Haiku 4.5；test/model-catalog.test.ts | requested 与 effective 分开 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/thinking-options.ts | test/model-catalog.test.ts | 原生动态能力 |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/permission-modes.ts | test/permission-modes.test.ts | live scope |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 受限 | src/claude-code-adapter.ts | test/claude-code-adapter.test.ts | bypass 不可用时拒绝，不模拟授权 |
| B5 | Fork | 原生有则必做 | P1 | 受限 | src/claude-fork.ts、claude-fork-references.ts | test/claude-queued-fork.test.ts、claude-rollback.test.ts、claude-fork-references.test.ts | 校验原生完整前缀；本次不执行真实 Fork |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 不支持 | src/claude-code-adapter.ts | history.forkAcrossCwd=false；test/claude-code-adapter.test.ts | 原生会话 cwd 约束 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 受限 | src/claude-fork.ts、pending-session.ts | test/claude-rollback.test.ts | 派生并校验前缀，不改源 Session |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/native-message.ts、tool-lifecycle.ts、file-change.ts | test/native-message.test.ts、file-change.test.ts | 历史不把普通附件当用户输入 |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/sdk-transport.ts、claude-code-adapter.ts | test/sdk-transport.test.ts、claude-code-adapter.test.ts | 使用公共 Interaction |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | src/sdk-transport.ts、claude-code-adapter.ts | test/sdk-transport.test.ts、claude-code-adapter.test.ts | 使用原生问题回调 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 支持 | src/subagent-lifecycle.ts、claude-history.ts | test/claude-history.test.ts、native-message.test.ts | 根级与子 Agent 不混淆 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/claude-code-adapter.ts、background-occupancy.ts | test/claude-code-adapter.autonomous.test.ts | 后台通知与人类输入分别处理 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/claude-usage.ts | test/claude-usage.test.ts | 费用来源如实报告 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 支持 | src/usage-estimate.ts、claude-code-adapter.ts | test/usage-estimate.test.ts | 原生 usage 与估算区分 |
| B15 | 接收委派 | 必做（验证项） | P1 | 待验证 | src/plugin.ts | test/plugin-delegation.test.ts | 本次不执行委派 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | src/plugin.ts、user-shell-environment.ts | test/plugin-delegation.test.ts | 本次不执行委派 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、assets/icon.svg | Manifest links / icon | 不改 Desktop 私有绑定 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | installation 字段 | 本次不安装 |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts | test/installation.test.ts | 本次不更新 CLI |
| C4 | 首次安装 | 可选 | P2 | 支持 | src/plugin.ts | createHarnessInstaller 原生安装命令 | 本次未执行安装 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | src/plugin.ts、command.ts | test/command.test.ts | 使用公共 launchCommand 环境 |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/claude-session-import.ts | test/claude-session-import.test.ts | 本次不新建导入映射 |
| C7 | 全局用量统计 | 可选 | P2 | 支持 | src/claude-usage-statistics.ts | test/claude-usage-statistics.test.ts | 只读原生数据 |
| C8 | 账号额度 | 可选 | P2 | 受限 | src/account-usage.ts | test/account-usage.test.ts | 依原生账号与可用额度接口，不读出凭据 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json | `npm run build:typescript` | 包含插件打包，已通过 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | manifest.json | scripts/release/harness-plugins.json 既有条目 | 本次不修改发行清单 |
| D3 | 加载测试 | 预装时必做 | P1 | 待验证 | src/plugin.ts | 既有 installed-harness-plugins 测试 | 本次不替换/加载已安装插件 |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/claude-code/claude-code-steer.md | 本次同步历史规则及限制 | 不新增 docs 导航项 |
| D5 | 其他 | 可选 | P2 | 不适用 | — | 本次不改额外产品接入 | — |

## 受限与已知缺口

- 本清单记录现有实现与本次历史修复范围，不是所有原生版本、平台、Desktop、委派和发行加载的完整认证。
- A6、B4：取消、无头权限依赖原生能力和确认；不承诺所有 CLI 版本一致。
- A7：只恢复有明确人类来源的 prompt queued_command；不推断其他附件。原生结果证据不完整时保持 unknown。公共历史 Item 不携带本地 Web requestId 或每条输入的发送时间。
- B5、B7：只接受原生可精确保留且验证通过的前缀，不把附件 UUID 用作 checkpoint；原生 Fork 未保留内容时拒绝派生结果。
- B12、C8：后台续态与额度依原生帧/接口，不将未知状态猜成支持或成功。
- B15、B16、D3：仅定位既有实现/测试，没有完成完整委派或插件 Loader/发行验证。

## 插件外改动

`docs/harnesses/claude-code/claude-code-steer.md` 记录冷历史恢复规则、checkpoint 与验证边界。恢复输入使用已有 `HostUserMessageItem`，不扩展公共契约；Web 通过通用的同轮用户 Item 投影独立显示，不读取 Claude 原生 attachment。官方 Codex 的队列和实时工具修复由 Host Runtime 负责，不属于本插件。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 | `npx vitest run --config tests/vitest.config.js` 指定 claude-queued-history、claude-transcript、claude-history、claude-queued-fork、claude-rollback、claude-fork-references、claude-code-adapter 七个测试文件 | 聚焦历史测试及完整 adapter 文件通过；与 Host 回归合计 312 项 |
| 类型与静态检查 | 插件 `tsc --noEmit`（buildInfo 放临时目录）；按 tests/tsconfig.json 选取三个所改测试文件创建 TypeScript Program；所改 TS 文件 eslint / prettier；`node tools/check-boundaries.mjs` | 通过；仓库 `npm run build:typescript`、`npm run typecheck` 与所改源码静态检查也通过 |
| 原生边界 | 当前源码默认 Adapter `open(resume)` / `readSnapshot()` 只读三份既有 CLI 2.1.319 / claude-haiku-4-5-20251001 测试 transcript | 恢复 3 + 2 + 2 条输入，10 + 2 + 2 个 Turn、checkpoint 及其他 Item 不变；重复读取稳定；源文件 SHA-256 不变；不发任务 |
| 插件加载 | `npm run build:typescript` 包含 `build:plugins`；不替换已安装插件 | 构建通过；已安装 CC 插件加载未验收 |
| Host 集成 | 运行中共享 Host 保持原状 | 本次未部署修复 |
| 真实原生验收 | 新模型执行、真实 Fork / rollback | 本次未执行；仅只读历史 |
| Desktop / 委派 | GUI 工具限制与本次范围 | 本次未执行 |

本次原生回放和聚焦测试结果存于 `/tmp/cc-queued-command-analysis-7WczIV/`，这是本地临时证据，不是发行依赖。冷历史 Item 身份稳定于原生记录，不承诺与 Host 的实时 Item ID 或本地 Web requestId 相同。
