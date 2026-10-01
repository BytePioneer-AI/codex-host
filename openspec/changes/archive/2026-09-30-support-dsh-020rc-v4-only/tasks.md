## 0. 基线

- [x] 0.1 在与 upstream main `94e795f8` 一致的新工作树中执行 `npm ci`、`npm run build:typescript` 后复跑 DSH Adapter 测试：24 个文件、865 个用例全部通过；旧目录的 6 个失败来自未重新构建的 `dist`，不带入本变更。
- [x] 0.2 用 OpenSpec CLI 对本 change 做 strict 校验（本机未安装该 CLI，使用 `npx -y @fission-ai/openspec@latest validate support-dsh-020rc-v4-only --strict --no-interactive`）。
- [x] 0.3 cherry-pick PR #412 的 5 个提交并保留原作者（整理提交时合并为本 PR 的前 2 个提交）；DSH Adapter 测试 25 个文件、891 个用例全部通过。评估 CodeRabbit 关于 `auto` 的建议（design 决策 8），不采纳。

## 1. 对接 0.2.0（保留现有三格式代码）

- [x] 1.1 V4 历史校验与冷历史投影接受 DSH 恢复产生的合成 `tool/result`（design 决策 4）；按 0.2.0 源码形状补正例（未启动 / 已启动 × `forked` / `interrupted`）与负例（id、错误码、`sourceEventSeqs`、内容不符）。 完成于 `7da8437b`；真实 CLI 崩溃探测在四个版本上确认 DSH 写出的两种 `interrupted-tool-result-*`，修复前的 Adapter 恢复失败。
- [x] 1.2 实时投影记录 Assistant 宣告的工具调用：未启动调用的合成结果投影为失败工具项，Item 身份与冷历史一致；PTC `run_code` 不生成 Item。 完成于 `7da8437b`。
- [x] 1.3 `user-questions/request` 解析允许可选 `wait`（design 决策 5）；测试覆盖无 `wait`、合法 `wait`、非法 `wait`，以及回放时 `wait` 不一致的拒绝。 完成于 `88ad6228`。
- [x] 1.4 实现同一回合内的迟到回答：timed 提问在回合进行中被 DSH 取消时保持打开；按原生 `tool/result`/`tool/ptc-dispatch` 转为 continued 或关闭；continued 回答调用 `userQuestions/answer`（`true` → responded，`false`/业务失败 → superseded，传输失败保持打开，跳过只在本地关闭）；竞态中保留的回答在 pending 结果出现后补发；回合结束前以 `expired` 关闭。非 timed 提问的现有行为不变。 完成于 `88ad6228`；`0.2.0-rc.2` 真实 CLI 探测覆盖迟到回答（`responded`，模型收到回复）、到期不答（`expired`）和及时回答。
- [x] 1.5 补 `user-question-reply` 消息来源在 `user/message` 与 `agent/inbox/spliced` 中的 V4 回归测试，确认它不被投影为用户输入，也不影响提示词关联。 实时路径由 `session.test.ts` 的迟到回答用例覆盖（`agent/inbox/spliced` 与 `user/message`）；冷历史补 `history.test.ts` 用例。
- [x] 1.6 在仓库外隔离安装 `0.2.0-rc.1`、`0.2.0-rc.2` 与 `0.1.7-rc.2`，设置 `CODEXHOST_DSH_REAL_COMMAND` 运行 `tools/gate-dsh/lifecycle.real.test.mjs`。记录平台、Node、npm、Vitest 与耗时；CLI 问题与测试桩问题分别归因。 Linux x86_64、Node.js `v22.23.2`、npm `10.9.8`、Vitest `4.1.10`：`0.2.0-rc.2` 5.89 秒、`0.2.0-rc.1` 6.04 秒、`0.1.7-rc.2` 6.43 秒均 1/1 通过；另复验 `0.1.7-rc.1`，首次因模型桩把并发标题请求误判为主请求而失败，3 次复跑均通过。
- [x] 1.7 评估能否在 Gate 模型桩中稳定触发 step 失败与 timed 提问；不能则在验证记录中注明该路径仅有定向测试。 Gate 模型桩不能稳定触发这两条路径，改用单独的真实 CLI 探测验证崩溃恢复与限时提问；失败的 step 与 Fork 种子的补写结果只有定向测试，已在验证记录中注明。

## 2. 删除 V0/V3

- [x] 2.1 在 `profile.ts`/`generation-selector.ts` 加入最低版本 `0.1.7-rc.1`：低于它的版本在启动 Web 前返回 `unsupported`，带中英文升级提示。测试覆盖边界与预发布排序：`0.1.2-rc.1`、`0.1.5-rc.3`、`0.1.7-alpha.2`、`0.1.7-rc.0` 拒绝；`0.1.7-rc.1`、`0.2.0-rc.2`、`0.2.0`、`1.0.0` 接受。 完成于 `fb1b753e`；用本机 `0.1.5-rc.2` 实测 70 毫秒内返回 `unsupported`，托管 Web 未启动。之后提示改为列出四个支持版本，并说明高于 `0.2.0-rc.2` 的版本可以尝试连接但适配度可能有限，测试逐字校验中英文提示（整理提交时并入同一提交）；`0.1.5-rc.2` 复测 71 毫秒内返回。
- [x] 2.2 合并 `profiles/v015.ts` 与 `profiles/v017.ts` 为 `profiles/v4.ts`，删除 `profiles/v012.ts`；`profile.ts` 只保留接口、SemVer 比较与门槛。 完成于 `6b044e0f`。
- [x] 2.3 删除 `modern/*` 与顶层 Adapter 中的非 V4 分支（含 #412 的 `projectsPtcDispatches` 格式判断与 `settings/describe` 权限路径），默认 profile 改为 V4，去掉 modern adapter 默认的 `0.1.2-rc.1`。 完成于 `6b044e0f`；插件运行依赖同时去掉只供 V0/V3 权限解析使用的 `@deepseek-ai/schemastery`。
- [x] 2.4 简化 Session 引用校验（design 决策 3）。测试覆盖：无 locator、`0.1.5-rc.2` locator、`0.2.0-rc.2` locator 可恢复；`turn-end:`、`v3-turn-end:` 以及版本不一致的 checkpoint 在 mutation 前拒绝。 完成于 `6b044e0f`；真实 CLI 探测另确认 `0.1.5-rc.2` locator 可恢复、版本不符的 checkpoint 返回 `invalidRequest`、`v3-turn-end:` 返回 `checkpointNotFound`，源会话均不变。
- [x] 2.5 把依赖默认 V0/V3 的测试改写为 V4 数据（`history.test.ts`、`journal.test.ts`、`session.test.ts`、modern adapter 测试等），再删除 V0/V3 专用用例和 V3 夹具；共享的流式与 baseline 用例迁入 V4 测试。 完成于 `6b044e0f`；新增逐字节取自 `dsh-v0.2.0-rc.2` 的 V4 实录夹具。
- [x] 2.6 运行 `npm run test:deepseek:coverage`，保持四项 80% 门槛；记录实际覆盖率。 25 个文件、876 项测试全部通过；语句 86.99%、分支 82.67%、函数 93.29%、行 89.78%。

## 3. 界面与文档

- [x] 3.1 `renderer-extension`：更新连接页中英文已验证版本文案、DSH 安装指引固定版本（design 决策 7）和 `pages.test.ts`。 Renderer 设置测试 10 个文件、137 项通过。之后连接页说明改为提示高于 `0.2.0-rc.2` 的版本可以尝试连接但适配度可能有限，低于 `0.1.7-rc.1` 的版本需要先升级。
- [x] 3.2 `git mv docs/harnesses/deepseek/dsh-015rc1-validation.md docs/harnesses/deepseek/dsh-version-validation.md` 并重写：0.2.0 审计与 Gate 证据、最低版本、移除 V0/V3 的说明、#412 的显示规则、迟到回答边界。更新 `dsh-edit-recovery.md`（仅 V4 checkpoint）、`docs/architecture/` 中 5 篇提及版本的文档，以及 `docs/index.md` 的路径与描述。 另同步 `harness-plugin-runtime.md`、OpenCode 调研与外部 Harness 提案中的历史注记，以及 `codexhost-add-harness` skill 参考中已删除的 `legacy/` 入口。
- [x] 3.3 归档本 change，把 delta 合入 `openspec/specs/` 四份主规格，并同步其 Purpose 中的版本描述。

## 4. 验证与提交

- [x] 4.1 运行 `npm run build:typescript`、`npm run typecheck`、`npm run lint`、改动文件的 Prettier 检查、`git diff --check` 和 OpenSpec strict 校验；只在相关代码被触及时扩大到其他 Gate。 构建、Prettier、`cargo fmt`、包边界、改动文件 eslint、`git diff --check` 与 OpenSpec strict 通过；`typecheck`/`lint` 只报基线既有的 `tests/e2e/renderer-model-fast.spec.ts` 错误。另跑全量 Vitest：`tests/release` 需去掉环境中的 `CODEX_HOME`，此外只有 WorkBuddy 一个依赖目录权限的用例因本机以 root 运行而失败，两者均与本变更无关。
- [x] 4.2 按阶段写中文提交，推送 fork 分支 `feat/dsh-020rc-v4-only`，向 upstream main 提 draft PR。PR 写明整体与按业务代码、测试代码、文档分列的增删行数，纳入 #412 的说明与 CodeRabbit 结论，以及实际验证与未验证边界（真实模型、Desktop 端到端、其他平台）；Desktop 手测由用户完成后再转为 ready。 已推送并创建 draft PR；Desktop 手测完成后再转为 ready。
