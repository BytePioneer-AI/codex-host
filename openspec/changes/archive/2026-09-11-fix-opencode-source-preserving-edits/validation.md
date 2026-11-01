# 验证记录

独立基于上游 `e8f8ecd`。

- `npm run typecheck`：通过。
- Adapter 回归测试：7 个文件、72 个用例通过；2 个真实 CLI 文件、2 个用例未启用而跳过。
- 变更文件 ESLint、Prettier 和 `git diff --check`：通过。

未将集成分支或未执行的真实 CLI、其他平台测试视为本分支验证。
