# Codex 账号展示

CodexHost 不再提供全局 Codex 多账号切换。Account 仍是认证身份，不等于 Harness、Model、Provider 或 Billing Source；不建立 Model 代理、每账号后台或 per-Thread 账号路由。

设置 → 账号显示当前官方 Codex 身份、官方 `account/rateLimits/read` 额度，以及其他 Harness 的只读 `inspectAccount()` 行。另提供显式确认后将兼容授权一次性导入 Pi 的独立入口；这不切换官方 Codex 登录、不建立 Host 凭据收藏库。官方 Desktop 登录/退出仍由官方后端处理。Host 不读取或改写 `.codexhost-native-accounts`。

Host 准备阶段只初始化原生身份读取连接，不主动预取账号；Desktop 接入已就绪的原生后端时，账号观察器只记录后端代次，不在 `initialize` 响应后额外读取账号，避免干扰官方认证与项目侧栏的初始化顺序。真实账号变更、登录完成和后端代次变化仍按原生事件处理。Renderer 和账号页面通过账号查询按需刷新身份，不依赖启动时一定收到账号通知；额度继续通过独立的 `account/rateLimits/read` 查询。

产品契约见 `openspec/changes/remove-codex-multi-account/`。用户可见行为见 [账号与额度设置](codex-accounts.md)。
