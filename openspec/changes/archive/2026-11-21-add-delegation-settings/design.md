## Design

### 1. 偏好存储契约（`shared-contracts` + `harness-plugin-files`）

- 在 `harnessPreferenceValuesSchema` 新增可选字段：
  - `delegation: { byHarness: Record<HarnessId, { model?: HarnessModelRef, thinkingOptionId?: HarnessThinkingOptionId }> }`
- 在 `harnessPreferenceOperationSchema` 新增操作：
  - `{ kind: "delegation", harnessId: HarnessId, configuration?: { model?: HarnessModelRef, thinkingOptionId?: HarnessThinkingOptionId } | null }`
  - `configuration` 为 `null` 或 `undefined`（或清空后无字段）时删除 `byHarness[harnessId]`，语义为恢复「跟随 Agent 默认」。
  - `harnessId` 使用 `harnessIdSchema`，同时支持官方 `codex` 与外部 Harness，不写入标签文字或探测结果。
- `HarnessPreferencesStore`（`harness-preferences-v1.json`）复用现有的串行写入、原子替换、版本递增与跨进程文件监听通知，无需新文件或新 RPC。

### 2. 委派启动解析（`host-runtime`）

- 在最终创建子 Thread 的 `HarnessDelegationCoordinator.start()` 读取一次 `HarnessPreferencesStore.get("external")` 中的 `values.delegation?.byHarness[targetHarnessId]`。
  - 官方 `codex` 在本地 Host 执行 `#startOfficialDelegation`；共享 Host 模式下外部 Harness 转交共享 owner 执行 `start()`，两边读同一数据目录的偏好文件，行为一致。
- 三级优先级与边界：
  1. 显式传参（`input.model` / `input.thinkingOptionId`）最高，非法显式参数按原有规则抛 `INVALID_ARGUMENT`。
  2. 未传 `input.model` 且未传 `input.thinkingOptionId` 时，采用已保存的 `{ model, thinkingOptionId }`。
  3. 仅显式传了 `input.model`、未传 `input.thinkingOptionId` 时，**不继承**已保存默认里的 `thinkingOptionId`（除非显式模型与已保存模型完全一致，或直接以本次显式模型为准不混用旧档位——实现采用**显式指定了不同模型时不继承已保存思考强度**），避免跨模型不兼容错误。
  4. 仅显式传了 `input.thinkingOptionId`、未传 `input.model` 时，可继承已保存默认 `model`（若该默认模型与显式思考强度合法匹配；若默认模型已失效，则回退到原生默认模型再按显式思考强度校验）。
  5. 若保存的 `model` 或 `thinkingOptionId` 在目标目录校验中确认无效（模型不存在、不支持模型/思考强度选择、或所选模型不支持该档位），静默忽略失效的默认项并回退到 Agent 原生默认，不阻塞委派、不自动删除用户原配置。
  6. `requestId` 与隐式去重的 `taskDigest` 仍基于调用方原始输入，确保修改默认设置后重试同一 `requestId` 仍幂等命中原记录。
- CLI Help（`delegation-cli-help.ts`）与内置委派 Skill（`delegation-skill.ts`）同步一句说明：省略 `--model` / `--thinking` 时优先使用委派默认设置，未设置则使用原生默认。

### 3. 双端共享「委派」设置页（`renderer-extension` + `apps/web-ui`）

- 在 `packages/renderer-extension/src/settings/` 新增 `delegation-page.ts`，按 8792 设计稿实现三段内容：
  1. 顶部多 Agent 委派与回流动画示意图（`@container codexhost-settings-page (max-width: 760px)` 切换横/竖排；尊重 `prefers-reduced-motion`；支持明/暗色与设置页主题变量）；
  2. 一行 `#` 唤起委派示例（点击复制并轮换示例）；
  3. 「被委派时的默认模型」扁平列表与优先级提示。
- **Agent 列表来源**：固定包含内置 `codex`，再叠加 `RendererConnectionDiagnostics` 中 `availability === "ready"` 的本地 Harness（按既有连接/展示顺序排列，不显示未安装或未就绪项）。Web 侧 `createConsoleConnectionDiagnostics` 保留现有能力，同时允许设置页在不强制全量刷新的情况下订阅已有状态。
- **模型与思考强度按需读取**：
  - 首屏展示已就绪的 Agent 列表与已保存的偏好状态（未设置显示「跟随 Agent 默认」），**不并发调用所有 Harness 的完整 `inspect`**。
  - 用户聚焦/点击某行模型或思考强度下拉框时，对该 Harness 调用 `client.inspectHarness({ harnessId })`（不传 `refresh`），成功后缓存于页面实例内存并填充模型选项与所选模型支持的 `supportedThinkingOptionIds`；若 `selectThinkingOption` 为 `false` 或当前模型无支持档位，隐藏思考强度下拉框。
  - 更改或点击「重置」时通过 `patchHarnessPreferences` 写入 `kind: "delegation"`，并订阅 `subscribeHarnessPreferences` 与外部变更同步。
- **双端接入**：
  - Desktop：在 `pages.ts` 注册 `delegation` 页面，经 `renderer-settings-lifecycle.ts` 与 `renderer-binding-probe.ts` 传入本地 `RendererModelClient`（偏好读写 + `inspectHarness`）和 `RendererConnectionDiagnostics`。
  - Web：在 `web-settings-entry.ts` 自动随 `createDefaultRendererSettingsPages` 挂载，在 `apps/web-ui/packages/client/ui-codexhost/src/client/index.ts` 的 `HOST_SETTINGS_PAGES` 与 `locales.ts` 注册 `delegation` 导航项。
