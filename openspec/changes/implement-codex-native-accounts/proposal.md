## Why

旧的 per-Account home／后台池／Thread 路由把账号身份和会话数据空间耦合，不能表达真正的原生全局账号切换。需要保留官方 Codex 的协议和能力，以停止—替换凭据—重启验证实现单后台、多加密凭据，不建立模型请求代理。

用户已授权基于 `9d22515ec63d5ff79eec4a12d6d56b721b2bd361` 在独立 worktree 实现。opencodex native profile 是核心参考；PR #252 仅作为选择性复用材料。

## What Changes

- 固定一个正式 `CODEX_HOME`、一个官方进程 Owner；本地托管使用受保护 loopback 和优先初始化的管理连接。
- 一个原子 Vault 提交 metadata、current 和非当前密文；一个事务执行者处理切换、首次激活、当前重登、退出及事实恢复。
- 短命认证 staging 与正式后台严格不并行。设置页添加 B 不覆盖 A；原生 Desktop OAuth／设备代码登录保留激活本次身份的语义，共用同一事务。业务提交和清理结果分开表达。
- Desktop initialize 与 Codex readiness 分开；保留原生登录应答／完成／账号更新协议，不以局部 Codex 故障关闭整个 Desktop 或伪造认证。
- v2 公开快照、Settings 全局切换和只读 Composer 身份；移除旧 per-draft 选择、后台池和 Thread→Account 执行路由。
- 保留非当前额度和受控 OAuth 刷新；私有 I/O、OS 密钥和进程证明由通用 Rust 原语提供。
- 将旧凭据接入与完整历史迁移分开：旧登记当前账号已使用正式 home 时，经原生身份／存储验证和停止 writer 后只读导入缺失凭据到 Vault，启用同一 home 中的全局切换；来源摘要防止重复导入。当前范围只保全主账号正式 home 的原历史；其他旧账号历史不要求迁移、合并或在新版显示，旧目录不主动删除。干净未托管 home 的其他 CLI 只禁用账号变更，不阻断普通原生启动；危险托管恢复和布局冲突仍硬阻断。

## Non-goals

- 模型请求代理、Header 替换、外部 Token 热登录、自动账号轮换或后台池。
- 改变 Model、Provider、Thread ID、历史或实际 Billing Source 语义。
- 完成真实账号登录／推理、读取真实密钥或发布。提交、推送、普通审查 PR 及诊断用 Desktop 起停已获用户后续授权；隔离 CLI 的 OAuth 开始／取消不代表真实认证验收。
- 假定全部官方版本、平台或旧数据布局已经验证；未确认阶段与采集值前不生成迁移向导。

## Capabilities

### New Capabilities

- `codex-native-global-accounts`: 单后台、全局准入、Thread 连续性、公开状态及原生降级。
- `codex-native-credential-lifecycle`: 加密 Vault、事务恢复、隔离登录、额度刷新及无损升级边界。

### Modified Capabilities

无新增 Harness 插件契约；旧账号选择字段的移除随 v2 账号接口和现有严格请求校验一起生效。

## Impact

涉及 Host Runtime、浏览器安全契约、Renderer／Draft 绑定、Rust 平台与 launcher、发行许可和聚焦测试。Host 仍通过插件公共契约加载其他 Harness，不引入 Adapter SDK 依赖。实现状态、支持限制及未完成的发布门槛见 `tasks.md` 和 `evidence.md`。
