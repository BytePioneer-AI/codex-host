## 1. 原生枚举与投影（Claude Adapter）

- [x] 1.1 `sdk-transport.ts` 两处 `settingSources` 从 `["user"]` 扩为 `["user", "project", "local"]`。
- [x] 1.2 Transport 在 open/resume 后拉取 `initializationResult()` 的 `skills` 名单与 `supportedCommands()` 全量列表，暴露 skill 枚举 seam。
- [x] 1.3 Consume 循环新增 `system/commands_changed` 分支，REPLACE 缓存并触发 catalog 失效通知。
- [x] 1.4 Adapter 将 skill 投影为 `HarnessCommandCatalog`（`claude.skill.` 前缀 ID、argumentHint→argumentMode、冲突拒绝并写诊断），与静态 catalog 保持互斥。
- [x] 1.5 Adapter 增加 skill 执行体：`runTurn("/" + name + (args ? " " + args : ""))`，沿用现有 Turn 投影、busy 拒绝与取消通路。

## 2. 契约与 Host 路由

- [x] 2.1 `harness-adapter` 的 session capabilities 增加可选 `skills`（复用 `HarnessCommandCapability` 类型）。
- [x] 2.2 `shared-contracts` 增加 `threadSkillsInspect` params/result schema（复用现有 descriptor/catalog schema）(reused existing schemas per ruling — no new schema)。
- [x] 2.3 `app-server-host.ts` 增加 `codexhost/thread/skills/inspect` 路由；未声明 skills capability 的 Harness 返回空 catalog。
- [x] 2.4 `commands/execute` 的 Adapter 侧边界按两个 catalog 并集校验（Host 仍只做未知 ID 拒绝），Claude Adapter 内部按 `claude.skill.` 前缀分派到 skill 执行体。

## 3. Renderer

- [x] 3.1 新 `renderer-harness-skill-control.ts`：独立按钮 + popover（顶部过滤输入框），布局/焦点/滚动照抄 command control 模式，空 catalog 隐藏。
- [x] 3.2 Composer 挂载（紧邻 Harness Commands 按钮）与 catalog 拉取（`skills/inspect`），复用 `renderer-model-client.ts` 的请求通路。
- [x] 3.3 `Cmd/Ctrl+Shift+S` document capture keydown 打开 popover；catalog 为空时不响应。
- [x] 3.4 zh/en/ko 本地化条目与按钮图标。

## 4. 测试与验证

- [x] 4.1 Adapter 聚焦测试：枚举过滤（skill vs 内置命令）、投影 schema 校验、ID 冲突诊断、`commands_changed` REPLACE 刷新、执行 payload、busy 拒绝、枚举不可用时静默降级。
- [x] 4.2 Host 聚焦测试：skills inspect 路由、非 Claude Harness 空 catalog、commands/execute 并集校验与跨 Harness 隔离。
- [x] 4.3 Renderer binding probe 增加 skill control 挂载、空态隐藏与快捷键行为断言 (coverage delivered via Playwright e2e spec per controller ruling)。
- [x] 4.4 运行 `npm run build:typescript`、`npm run typecheck`、`npm run lint`（含边界检查）、聚焦 vitest、`git diff --check`。
- [ ] 4.5 真机验证：在一个含 `.claude/skills` 的项目里确认项目 skill 出现在 Skills popover、点击后正常执行，且 CLAUDE.md 进入上下文。
- [x] 4.6 更新 `docs/harness-command-integration.md`（skill 接入路径、重申 Renderer 不解析 SKILL.md）与 release 说明（`settingSources` 行为变更）。
