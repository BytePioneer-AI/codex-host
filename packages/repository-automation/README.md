# @codexhost/repository-automation

私有、无第三方运行时依赖的源码 ESM 包。通过公共 `index.mjs` 供可信 GitHub 工作流使用，不打包进 Host 产品。

- `runMaintenance` / `maintainItem`：只给明确 `fix:` / `feat:` / `docs:` PR 标题打标签；当前 HEAD 的 CI 结束后更新一条简短结果评论，失败时摘录经过脱敏的原始日志。
- 不处理 Issue，不催补模板、不总结审查、不检查规范风险、不进行长期等待提醒。
- `readReleaseMetadata` / `resolveRelease` / `verifyRelease`：保持发布版本、标签、提交和 CI 证据一致。
- `validateReleaseVersion`：供发布准备脚本复用的版本校验器。

维护入口默认实际写入，调用方应明确传入 `dryRun: true` 做只读预览；GitHub 手动入口默认开启预览。自动化不调用模型、不执行 PR 代码，也不自动合并或发布。

详见 [仓库维护自动化](../../docs/repository-maintenance.md)。
