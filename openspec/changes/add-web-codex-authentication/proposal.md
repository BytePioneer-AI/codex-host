# Proposal

## Why

Web Codex 能列出模型却在实际执行时返回 401；现有检查没有核对原生认证，隔离 home 也没有 Web 登录入口。需要补齐最小认证闭环，而不是更换已正确采用的 app-server 接入方式。

## What Changes

- 检查当前 Provider 的原生认证要求；缺少所需认证时返回 `authenticationRequired`，不把模型目录可读当成执行就绪。
- 在 Web 现有设置中增加一行“Web Codex”：检查状态、发起 ChatGPT 设备码登录、展示验证码与验证链接、取消本次登录。
- 登录完成或收到明确的原生认证失败后，更新检查缓存及模型目录；不自动重发消息，不覆盖用户草稿或 Harness 选择。
- shared 与 standalone 复用同一插件认证能力；仍由各自唯一 owner 操作固定的隔离 home。

## Decisions

- 参考 Paseo 保留原生 app-server、stdio 和每会话进程；参考 T3 的先检查账户、再提供模型；参考 CodexMonitor 的原生登录完成通知。
- 首版只增加设备码登录这一条交互流程，避免局域网手机无法访问服务端 localhost 回调。已配置的原生 API Key 或自定义 Provider 仍可用，但不新增配置表单。
- 不复制 GUI 凭据、不更换 home、不恢复 GUI 多账号管理；仅明确允许隔离 Web 来源的单个当前登录。凭据存储与刷新继续归原生 CLI。
- 不引入 SDK/ACP、进程池、账户列表、退出/切换功能、凭据库或应用自管 Sign in with ChatGPT；后者作为独立后续议题。

## Capabilities

### New Capabilities

- `web-codex-authentication`: 隔离 Web Codex 的认证检查、单次原生登录、结果刷新与失败恢复。

### Modified Capabilities

- `codex-multi-account-removal`: 明确单个隔离 Web home 的原生登录例外，保持 GUI 账户只读、旧多账号方法删除及无宿主凭据副本的边界。

## Impact

- `harness-adapter` / `shared-contracts`：最小可选认证能力与固定 Web owner 操作，不提供任意原生 RPC。
- `adapters/codex`、`session-runtime`、`host-runtime`、`web-server`：原生认证、空闲会话释放、单次登录准入与缓存刷新；不改 Thread 身份或持久格式。
- `apps/web-ui`：复用设置插槽、现有事件通道与模型目录；无需新增页面或依赖。
- 实现时维护 `docs/product/standalone-web.md` 和 Adapter / Web README；Rust、GUI 官方 Codex 路由与 Renderer 不变。
