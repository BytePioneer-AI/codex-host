# Kimi Code 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `kimi-code` |
| 原生接口与传输方式 | Kimi Code ACP（stdio）；原生配置与历史文件 |
| 已验证的原生版本 | 2.5.3（模型目录、Thinking 与三档真实请求） |
| 交付范围 | 仓库内预装插件；本清单按源码和已有测试记录能力，不代表全功能实机验收 |
| 参考插件 | Copilot 的逐模型 Thinking 目录映射 |
| 最后验证 | macOS，独立 Host/Web 数据；用户授权的 custom Provider、gpt-6-luna；low / medium / high 各一次真实请求 |

## 能力

实现与测试路径相对于本插件；仓库路径以 `/` 开头。

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | /packages/host-runtime/test/installed-harness-plugins.test.ts | |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | /packages/host-runtime/test/installed-harness-plugins.test.ts | |
| A3 | 检查 | 必做 | P0 | 支持 | src/kimi-adapter.ts、src/models.ts | test/kimi-adapter.test.ts | 不创建会话；草稿读取明确声明的 Thinking |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/kimi-adapter.ts | test/kimi-adapter.test.ts | |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/kimi-session.ts | test/kimi-session.test.ts | |
| A6 | 取消 | 必做 | P0 | 支持 | src/kimi-session.ts、src/acp-transport.ts | test/acp-lifecycle.test.ts | |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/history.ts、src/kimi-session.ts | test/history-and-diff.test.ts | |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/kimi-adapter.ts、src/history.ts | test/kimi-adapter.test.ts | |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/kimi-session.ts | test/kimi-session.test.ts | |
| A10 | 关闭 | 必做 | P0 | 支持 | src/kimi-adapter.ts、src/kimi-session.ts | test/kimi-adapter.test.ts、test/kimi-session.test.ts | |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/kimi-session.ts | test/kimi-session.test.ts | |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/models.ts、src/kimi-session.ts | test/models-and-config.test.ts、test/kimi-session.test.ts | 会话以 ACP 列表和确认值为准 |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/models.ts、src/kimi-session.ts | test/kimi-session.test.ts | |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/kimi-adapter.ts | test/review-regressions.test.ts | 原生确认 yolo |
| B5 | Fork | 原生有则必做 | P1 | 受限 | src/kimi-adapter.ts | test/kimi-adapter.test.ts | 仅原生 head checkpoint |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 受限 | src/kimi-session.ts | test/kimi-adapter.test.ts | 声明 forkAcrossCwd=false |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 支持 | src/native-rollback.ts | test/rollback.test.ts | |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/kimi-session.ts、src/history.ts、src/slash-commands.ts | test/history-and-diff.test.ts、test/slash-commands.test.ts | |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/kimi-session.ts、src/plan-approval.ts | test/kimi-session.test.ts、test/plan-approval.test.ts | |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | src/kimi-session.ts | test/kimi-session.test.ts | |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 待验证 | src/kimi-session.ts | capabilities.subagents=false | 未接入观测与转写 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 待验证 | src/kimi-session.ts | capabilities.autonomousTurns.observe=false | 未接入后台自主输出 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/history.ts、src/kimi-session.ts | test/history-and-diff.test.ts | |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | src/kimi-session.ts | 未提供 usage.request / usage.history | |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/kimi-adapter.ts | test/kimi-adapter.test.ts、test/review-regressions.test.ts | 原生 yolo 确认有测试；未做真实模型委派验收 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | src/acp-transport.ts | 未做原生 CLI 发现与调用验收 | |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、src/models.ts | test/models-and-config.test.ts | |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | /packages/host-runtime/test/installed-harness-plugins.test.ts | |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts、src/plugin.ts | test/installation.test.ts | |
| C4 | 首次安装 | 可选 | P2 | 支持 | src/plugin.ts | createHarnessInstaller 原生安装脚本 | |
| C5 | 自定义启动路径 | 条件必做 | P1 | 受限 | src/command.ts、src/plugin.ts | CODEXHOST_KIMI_COMMAND 环境覆盖 | Manifest 未声明 launchCommand |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/session-import.ts | test/session-import.test.ts | |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | src/kimi-adapter.ts | 未提供 usageStatistics | |
| C8 | 账号额度 | 可选 | P2 | 受限 | src/account-identity.ts、src/kimi-adapter.ts | test/account-identity.test.ts | inspectAccount；未提供会话 credits 接口 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json | /tsconfig.json | |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | /scripts/release/harness-plugins.json | 清单包含 kimi-code | |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | /packages/host-runtime/test/installed-harness-plugins.test.ts | |
| D4 | 文档 | 预装时必做 | P1 | 支持 | /docs/harnesses/capability-boundaries.md | Kimi Thinking 配置章节 | |
| D5 | 其他 | 可选 | P2 | 不适用 | — | 无额外集成改动 | |

## 受限与已知缺口

- 草稿只使用模型明确声明的能力，不推断自定义模型后端支持的档位；会话打开和切换后的 ACP 响应优先于草稿目录。
- Fork 仅支持原生 head checkpoint，不支持跨目录 Fork。
- 原生 Subagent、自主 Turn、请求级计量、向下委派与全局用量统计尚无完整接入验证。
- 接收委派的 yolo 确认有聚焦测试，真实模型端到端验收未执行。
- 自定义启动路径依赖环境覆盖；账号检查可返回额度，未提供会话额度刷新接口。

## 插件外改动

- `docs/harnesses/capability-boundaries.md`：说明草稿目录使用配置中的 Thinking 能力声明。
- 无 Host、Web、Renderer 或公共契约改动。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 | `npx vitest run --config tests/vitest.config.js packages/adapters/kimi-code/test/models-and-config.test.ts packages/adapters/kimi-code/test/kimi-adapter.test.ts` | 修复前 7 项失败；修复后 2 个文件、56 项通过 |
| 原生边界 | Kimi 2.5.3 隔离 ACP：无声明 / thinking / thinking + support_efforts | 分别返回无选项 / off,on / 声明档位 |
| 插件加载 | 源码 Web 构建及独立 Host 加载打包插件 | 启动成功；未额外执行 installed-harness-plugins 测试 |
| Host 集成 | Web 新建页选项、会话内切换、刷新恢复 | Off / Low / Medium / High 可见；刷新保留 High 和三轮回复 |
| 真实原生验收 | Kimi 2.5.3、macOS、custom Provider、gpt-6-luna；三轮 Web 请求 | low / medium / high 均完成并返回预期标记；原生 wire.jsonl 的 llm.request 分别记录对应 thinkingEffort；未调用工具。不以请求成功证明后端内部推理量差异 |
| Desktop / 委派 | 未启动界面或真实委派 | 未执行 |
