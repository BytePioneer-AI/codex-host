# @codexhost/repository-automation

私有、仅 Node.js 的仓库治理包，不属于 Host / Harness 产品运行时。拥有 Issue / PR 分类、轻量提示、GitHub 状态快照、规范例外、提醒和发布证据校验。

公共入口是源码 ESM `index.mjs`。可信工作流可按固定 checkout 路径导入这个公开入口，无需 `npm install` 或 TypeScript 构建；其他包不得导入 `src/` 内部模块。它不依赖其他 Workspace 包或第三方运行时依赖，也不包含模型调用。

- `runMaintenance({ github, context, core, number?, dryRun?, now? })`：根据可信 GitHub 事件选择条目；`github` / `context` / `core` 由 `actions/github-script` 提供。
- `maintainItem({ github, repo, number, dryRun?, now? })`：读取实时数据、生成建议并幂等更新自有评论；`dryRun` 禁止写入。
- `resolveRelease({ github, repo, root, tag, expectedRefSha? })`：只读本地可信 Git checkout 和 GitHub CI，返回不可变发布元数据和证据。
- `verifyRelease({ github, repo, tag, sha, tagObjectSha, ciRunId, ciRunAttempt })`：发布前重新核对远端标签和 CI；任何不可验证条件都拒绝发布。
- `validateReleaseVersion`、`readReleaseMetadata`、`assertReleaseCi`：供发布工具和测试复用的校验接口。

行为、权限、局限和操作说明见 [仓库维护自动化](../../docs/repository-maintenance.md)。

测试使用仓库 Vitest 配置：`npm run test --workspace=@codexhost/repository-automation`。真实写入只由 GitHub 工作流负责，本地测试不调用模型、不触发发布。
