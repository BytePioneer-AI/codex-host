# Devin CLI 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `devin` |
| 原生接口与传输方式 | `devin acp` stdio，`@agentclientprotocol/sdk` |
| 已验证的原生版本 | PR 原生记录：3000.10.31；本地 3000.11.205 仅验证隔离未认证的初始化及只读历史请求解析，不代表会话或修改历史验收 |
| 交付范围 | 预装插件；Desktop 与完整委派验收尚未完成 |
| 参考插件 | Qoder 的执行策略冲突拒绝；Pi 的配置确认、动态选项、历史边界及聚焦测试（不复用其协议或存储）；公共插件 Loader |
| 最后验证 | 本地 macOS：hermetic 测试及临时官方 CLI 未认证探测；无有效账号，未执行真实 Turn、Fork 或回滚 |

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
| A7 | 只读快照 | 必做 | P0 | 支持 | src/projection.ts、src/history.ts | test/devin-adapter.test.ts、test/history.test.ts；集成记录 | 同连接 load 回放；协商后由 listSteps 的真实 userMessageId 映射 checkpoint |
| A8 | 持久身份 + resume | 必做 | P0 | 受限 | src/projection.ts、src/adapter.ts | test/devin-adapter.test.ts；集成记录 | 压缩与取消历史未验证 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/adapter.ts | test/devin-adapter.test.ts、test/configuration.test.ts | 活动 Turn 与并行配置边界 |
| A10 | 关闭 | 必做 | P0 | 支持 | src/transport.ts、src/adapter.ts | test/devin-adapter.test.ts | 结束流及子进程 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/adapter.ts、src/models.ts | test/configuration.test.ts | 活动 Turn 直接调用原生 config，确认后发布状态 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 受限 | src/models.ts、src/adapter.ts、src/transport.ts | Devin stable changelog v3000.11.1；ACP Session Config Options 的 `category: thought_level`；test/thinking.test.ts、test/configuration-transport.test.ts | 动态发现、create/resume 提示、运行中选择、完整原生确认与选项替换；旧 CLI 返回 unsupported；真实 CLI 字段与行为待验收 |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/models.ts、src/adapter.ts | test/devin-adapter.test.ts | 原生确认后更新 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 受限 | src/adapter.ts | test/configuration.test.ts；原生 modes 目录含 bypass | 创建前拒绝非 bypass；真实工具执行未验收 |
| B5 | Fork | 原生有则必做 | P1 | 受限 | src/history.ts、src/transport.ts、src/adapter.ts | 官方 3000.11.205 revert 协商与静态原生字段；test/history.test.ts | 单一 forkFromStep 路径；运行时确认独立身份与精确前缀后才成功；真实 mutation 待作者验收 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 待验证 | src/history.ts、src/transport.ts | test/history.test.ts、test/history-transport.test.ts | forkAcrossCwd=false；source/child 均须 session/list 确认同一目标 cwd；不把进程 cwd 当原生证据 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 受限 | src/history.ts、src/adapter.ts | 同 B5；test/history.test.ts | 多轮复用精确 Fork；单轮独立空 Session；保留配置，不对源调用 execute/revert |
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
- B2：仅按 ACP 标准 `thought_level` select 类别发现独立 Thinking，使用原生 `id`、`currentValue`、`options[].value/name`（含分组）；未公开类别的字段不猜测。配置响应、通知和 load 的完整列表替换状态；create/resume 提示在 Model 后校验并写入。无可用 selector 时能力为 false、选择返回 unsupported；`model_config` 的 speed 不接入本任务。官方功能依据不替代实际 Devin wire 样本，3000.11.1+ 的真实 inspect、运行中选择、Model 依赖变化与冷恢复仍需作者验收。
- B5/B7：已实现协商驱动的单一路径，不以真实账号探测为能力开关。listSteps 仅将唯一 prompt step 的 userMessageId 精确对齐到 Host Turn；forkFromStep 返回独立 ID 后读回检查完整 Turn 与原生 transcript 前缀，并复读源历史确认不变。多轮 rollback 复用上一轮 Fork；单轮创建并加载独立空 Session；传入配置由原生确认并检查最终组合状态。活动操作互斥，失败关闭子资源；无安全删除契约，已知子 ID 的持久化残留在错误中报告。mock 与 synthetic ACP 覆盖此路径，不代表真实修改历史成功。
- 可选 live checkpoint 的 RPC/解析失败不改变已完成 Turn 终态，也不关闭健康 Session；仅 transport 已关闭/故障（含真实退出、超时关闭）才 fault。冷派生在临时 source 释放失败时关闭已创建 child，保留原始错误并报告持久化残留；清理失败不伪造成功。
- 原生未验证假设：listSteps 的 `{steps:[{kind,stepId,userMessageId}]}` 结构及 prompt ID 对齐；forkFromStep 的 `{sessionId,stepId}` 入参与完整 Turn 的包含边界；fork 不改文件；子身份、同 cwd 的 session/list 确认、独立继续与空 Session 持久性。3000.11.205 已观测协商和只读参数解析，静态字段不能当作 mutation 成功。假设不符必须运行时失败，不尝试其他 RPC；详见集成记录「History derivation」。B6 仍 false。无 execute(skipFileUndo)、/revert、prompt 重放、数据库复制或摘要替代。
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
| Adapter 公共行为 | `npx vitest run --config tests/vitest.config.js packages/adapters/devin/test` | 104 项通过（6 个文件）；含 Thinking、原生历史路径、执行策略、运行中 Model、权限状态保留与故障/关闭期间 snapshot 拒绝 |
| 原生边界 | Mock ACP；test/fixtures/configuration-acp.mjs、history-acp.mjs 合成 stdio 进程 | 请求驱动的配置通知、native history RPC wire/边界/错误与子进程退出；不读取凭据、不启动真实 Devin，非真实 CLI 验收 |
| 插件加载 | installed-harness-plugins.test.ts，筛选 `loads all preinstalled plugin factories without static registration or executable discovery` | 1 项通过，22 项因名称筛选跳过；加载构建产物，不发现或启动原生可执行文件 |
| 构建与静态检查 | npm run typecheck；npm run build:typescript；npm run lint；改动文件 Prettier；git diff --check | 全部通过；依赖用 npm ci --ignore-scripts 安装；未运行全量测试、真实 Devin 或 Desktop |
| 历史能力实现 | test/history.test.ts、test/history-transport.test.ts、test/fixtures/history-acp.mjs | 原生 ID/step 对齐、中间/末尾 Fork、配置保留、多轮/单轮/空历史 rollback、旧版 unsupported、活动操作互斥、错误 ID/前缀/opaque payload/源变更与资源清理；仅 mock/synthetic，非真实 mutation 验收 |
| 真实原生验收 | PR 集成记录中的 3000.10.31 / macOS / swe-2-high / accept-edits | 历史记录；本地未复验 |
| 未认证原生探测 | 官方 3000.11.205 macOS arm64，临时 HOME/XDG，initialize + listSteps/preview 的不存在 Session 输入 | 确认 revert 扩展协商与部分参数解析；未创建 Session、登录、执行模型或修改历史，详细边界见集成文档 |
| Desktop / 委派 | — | 未执行 |
