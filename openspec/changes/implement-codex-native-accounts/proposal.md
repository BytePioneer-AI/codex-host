## Why

Codex 全局账号管理需要在固定会话存储中使用实际原生认证身份。通过停止后台、替换原生凭据、重启验证，保持官方协议和能力，不建立模型请求代理。

## What Changes

- 固定正式 `CODEX_HOME`，由唯一 Owner 管理受保护 loopback 后台和专用管理连接。
- 切换进入 changing，停止受管及当次检测到的其他 Codex 后端，再安装和验证目标凭据；新请求拒绝，不排队或重放。
- 原子明文 Vault 保存 metadata、current 和非当前凭据；统一事务处理切换、首次激活、重登、退出和恢复。
- 私有认证 staging 与任务后台不并行。设置页添加只保存新账号；Desktop 原生登录使用本次身份。
- Host transport initialize 独立于 Codex readiness；原生认证事件保留协议语义。
- v2 快照、设置页全局操作、只读 Composer 身份和原生 Thread 懒恢复。
- 非当前额度及受控 OAuth 刷新独立于后台数量；Rust 提供私有 I/O、旧密钥读取和进程能力。
- 启动允许与 VS Code／CLI 共存；布局、身份和自身进程恢复事实约束管理能力。
- 旧登记当前账号使用正式 home 时可只读接入缺失凭据。主账号历史保留，其他 home 不合并、不自动删除。

## Non-goals

- 模型代理、Header 替换、外部 Token 热登录、自动账号轮换或每账号后台。
- 改变 Harness、Model、Provider、Thread ID 或 Billing Source 语义。
- 多客户端原子切换、临时内容和全部运行时设置的无损恢复。
- 完整多 home 历史迁移，以及未经验证的版本、平台或存储配置支持。

## Capabilities

### New Capabilities

- `codex-native-global-accounts`: 单个受管后台、全局准入、原生 Thread 连续性、公开状态和原生降级。
- `codex-native-credential-lifecycle`: 明文 Vault、旧密文转换、事务恢复、隔离登录及额度刷新。

### Modified Capabilities

Harness 插件通过现有公共契约运行。v2 账号请求明确拒绝 per-draft 账号输入和 activate 别名。

## Impact

涉及 Host Runtime、共享契约、Renderer／Draft 绑定、Rust 平台与 launcher、发行许可和聚焦测试。设计见 `design.md`，验收见 `tasks.md` 和 `evidence.md`。
