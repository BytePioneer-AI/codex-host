# Codex 账号展示

CodexHost 不再提供全局 Codex 多账号切换。Account 仍是认证身份，不等于 Harness、Model、Provider 或 Billing Source；不建立 Model 代理、每账号后台或 per-Thread 账号路由。

设置 → 账号只显示当前官方 Codex 身份、官方 `account/rateLimits/read` 额度，以及其他 Harness 的只读 `inspectAccount()` 行。官方 Desktop 登录/退出仍由官方后端处理。Host 不读取或改写 `.codexhost-native-accounts`。

产品契约见 `openspec/changes/remove-codex-multi-account/`。用户可见行为见 [账号与额度设置](codex-accounts.md)。
