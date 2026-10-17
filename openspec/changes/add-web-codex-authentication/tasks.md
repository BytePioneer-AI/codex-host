# Tasks

## 1. 原生认证能力

- [ ] 1.1 为 `harness-adapter` / `shared-contracts` 增加最小可选认证契约，并让 Codex 检查先核对原生认证要求。按目标 CLI 的离线 schema 校准字段；补契约和 Adapter 聚焦测试，覆盖“模型可读但未登录”、已有 API Key、自定义 Provider、检查超时与不兼容，断言没有创建 Thread 或发送 Turn；同步维护 Adapter README 的检查语义。
- [ ] 1.2 在 Codex Adapter 实现单次设备码登录、读取、取消及失效通知，复用控制连接；识别明确的原生模型认证失败。通过模拟原生 stdio 覆盖快速完成通知、双开始、旧取消、失败/过期、结果未知及进程退出，检查日志不含 challenge/token；区分模型 401 与工具正文中的 401，并更新 Adapter README 的原生登录范围。

## 2. 唯一 owner 与刷新

- [ ] 2.1 在 shared 与 standalone composition 接通三个固定认证操作及可选能力标记；复用 `activity()`、空闲释放和现有通知，串行控制登录/提交准入并更新所有相关检查缓存。补 owner、`session-runtime` 及 Web 网关测试，验证跨浏览器复用一次登录、关闭未确认时拒绝、忙碌工作不被取消、认证失败队列原位暂停且不阻止登录、旧响应不覆盖新状态、旧版本不 fallback、伪造 scope/home 被拒绝、GUI home 和旧账号方法不受影响；同步维护 Web README 的来源边界。

## 3. 最小 Web 入口

- [ ] 3.1 在 `ui-codexhost` 既有设置插槽增加一行 Web Codex 状态/检查/登录/取消，模型目录响应认证失效事件刷新。补桌面与手机尺寸浏览器测试，覆盖无可用模型仍可登录、成功/失败/取消、刷新页面恢复当前 challenge、重连、登录后模型出现、草稿与当前 Harness 不变、无自动发送与无凭据持久化；更新 `docs/product/standalone-web.md`，明确设备码单流程及不提供多账号管理。

## 4. 接入验收

- [ ] 4.1 用真实 Loader、模拟原生协议及临时 home 贯通“未登录 → 登录 → 刷新目录 → 用户提交 → 401 → 重新认证 → 原 Native Session 继续”，覆盖 shared、standalone 与网关重连；运行受影响 Vitest、Web Node/browser 定向测试及 `npm run typecheck`、边界检查，不默认跑全仓库。补齐现有说明中与新行为不一致的描述；真实 CLI 登录及一条短 Turn 仅在用户允许后执行，记录 CLI 版本、结果或未验证原因，不以模拟测试声称真实推理已通过。
