## 1. 偏好契约与持久化（Pi）
- [x] 在 `packages/shared-contracts/src/harness-preferences.ts` 新增 `delegation` 默认配置结构与 `kind: "delegation"` patch 操作（支持官方 `codex` 与外部 Harness，支持按 Harness 覆盖与清空）。
- [x] 在 `packages/harness-plugin-files/src/preferences.ts` 实现 `kind: "delegation"` 的写入、清空与修订号递增，并在 `packages/harness-plugin-files/test/preferences.test.ts` 补齐测试。
- [x] 验证：`npx tsc -b packages/shared-contracts packages/harness-plugin-files` 与 `npx vitest run --config tests/vitest.config.js packages/harness-plugin-files/test/preferences.test.ts`。

## 2. 委派启动解析生效（Pi）
- [x] 在 `packages/host-runtime/src/harness-delegation-coordinator.ts` 与 `app-server-host.ts` 注入偏好读取并在 `start()` 合并「本次指定 › 委派默认 › Agent 原生默认」（覆盖外部 Harness、官方 `codex` 与共享 Host 路径；显式不同模型不套用旧思考强度；已存覆盖失效静默回退；保留原始 `requestId` 去重摘要）。
- [x] 在 `packages/host-runtime/test/harness-delegation-coordinator.test.ts` 补齐上述场景测试。
- [x] 验证：`npx tsc -b packages/host-runtime` 与 `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/harness-delegation-coordinator.test.ts`。

## 3. 双端共享 8792「委派」设置页（Antigravity）
- [x] 按 8792 设计稿在 `packages/renderer-extension/src/settings/` 实现 `delegation-page.ts`、样式、图标与中英文文案，使用 `@container` 响应式切换，仅展示内置 Codex 与本机已就绪的 Harness，按需拉取模型与思考强度列表，并与偏好 RPC 联动保存/重置。
- [x] 在 `pages.ts`、`renderer-settings-lifecycle.ts`、`renderer-binding-probe.ts`、`web-settings-entry.ts` 及 `apps/web-ui/packages/client/ui-codexhost/src/client/` 注册 `delegation` 页面。
- [x] 在 `packages/renderer-extension/test/settings/` 补齐聚焦测试，并输出宽屏明暗与手机窄屏截图供审查。
- [x] 验证：`npx tsc -b packages/renderer-extension` 与聚焦设置页测试。

## 4. 文案、文档与收尾（Lead）
- [x] 同步 `delegation-cli-help.ts` 说明文案与 `docs/architecture/delegation-defaults.md` 文档，确认 `openspec validate add-delegation-settings` 通过。
