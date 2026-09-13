# 验证状态与支持边界

## 当前实现

- 正式 home 固定；最多一个受管官方后台，包括认证 staging。
- 切换进入 changing，停止受管及当次检测到的其他 Codex 后端，安装凭据、重启并验证。登录、退出也直接停止受管后端，但不主动停止外部后端。账号操作不扫描或追踪会话、不采集设置快照；旧 RPC 明确失败，新工作立即拒绝。busy 仅反映在途请求租约，额度本地超时或客户端分离不单独使 Codex unavailable；退出证明与 Host 任务收尾独立保留。
- Vault、Journal 和登录 candidate 使用私有明文文件。旧密文通过已有 OS 密钥进行可恢复的原地转换；明文库不访问密钥。
- 启动允许与其他 Codex 客户端共存。布局、来源、自身进程退出、凭据身份和 CAS 仍约束恢复及写入。
- 账号规格见 [全局账号](specs/codex-native-global-accounts/spec.md) 和 [凭据生命周期](specs/codex-native-credential-lifecycle/spec.md)，实现设计见 [原生账号管理](../../../docs/codex-native-account-switching-design.md)。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint`（含 Workspace 边界） | 通过 |
| Vitest：账号、事务、登录、Runtime、Host、远端原生连接、导航和契约，38 个文件 | 451 通过，12 跳过 |
| Playwright：账号设置与跨 Host 账号隔离，2 个文件 | 48 通过 |
| macOS Rust：旧密钥 IPC／校验、进程枚举及批次终止 | 9 通过 |
| `cargo fmt --all --check`、`git diff --check` | 通过 |
| `openspec validate implement-codex-native-accounts --strict` | 通过 |

Vitest 使用 `tests/vitest.config.js`，Playwright 使用 `tests/e2e/playwright.config.js`。跳过项受真实 CLI／helper 的 opt-in 环境或平台条件限制。测试使用合成凭据、临时目录、协议 peer 或模拟页面；Rust 进程测试只操作其合成进程。未运行全仓测试，也未操作真实账号或 Desktop，结果不等于真实多客户端切换验收。

## 待验证边界

- 当前停止策略在真实 Desktop 中的 A→B→A，以及同一 Thread 后续请求的认证、上下文和页面连续性。
- VS Code／CLI 后端的 PID／启动身份退出证据，以及编辑器自动重启后共享凭据的行为。
- Desktop／Host PID 连续性和其他 Harness 的流式输出、审批、取消与保存。
- Windows／Linux 的实际文件权限、进程树退出、Desktop 联合运行；编译检查不能替代运行验证。
- 旧密钥的授权拒绝、锁定及 helper 异常生命周期；自动化测试不访问真实 OS 密钥或真实认证网络。

版本范围为 `0.153.4`、`0.154.0-alpha.6.2` 的文件式 ChatGPT 认证，不代表所有平台和配置均已验收。切换可能丢失临时内容及运行时设置，不承诺多客户端原子切换。此能力尚未完成发布验收。
