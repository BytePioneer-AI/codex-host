# Spec Delta

## MODIFIED Requirements

### Requirement: Host SHALL NOT manage multiple Codex accounts

Host SHALL NOT 提供 Codex 多账号生命周期：不得保存凭据副本、运行 GUI Settings 设备码登录、替换官方 `auth.json`、为切换停止进程、删除收藏账号、恢复账号 journal 或退出后保留副本。唯一例外是用户显式为固定隔离 Web home 发起的单次原生登录或重新认证；该例外 MUST NOT 操作 GUI home、恢复旧账号方法或形成账号列表及切换能力。Account、Harness、Model、Provider、Billing Source SHALL 保持区分，不引入 Model 代理或按 Thread 选账号。

#### Scenario: Settings has no multi-account actions

- **WHEN** the user opens Settings → Accounts
- **THEN** the page SHALL NOT offer add, login, switch, Host logout, delete saved account, recover, or consume reset credits

#### Scenario: Removed Host account methods have no dedicated handler

- **WHEN** a client sends `codexhost/account/switch`, `codexhost/account/login/start`, `codexhost/account/login/cancel`, `codexhost/account/logout`, `codexhost/account/delete`, `codexhost/account/recover`, or `codexhost/account/rate-limit-reset/consume`
- **THEN** Host SHALL NOT run a dedicated handler for that method
- **AND** Host SHALL NOT return an account-specific unavailable or unsupported result
- **AND** the request SHALL follow the same path as other methods Host does not own

#### Scenario: No Host credential vault is used

- **WHEN** Host starts or the accounts page refreshes
- **THEN** Host SHALL NOT read, write, rewrite, or salvage `.codexhost-native-accounts`
- **AND** leftover Vault or 0.8.x account records MAY remain on disk unused

#### Scenario: Switching is not performed by replacing native auth

- **WHEN** more than one ChatGPT or Codex login exists on the machine or in leftover files
- **THEN** Host SHALL NOT install a non-current credential into the permanent `auth.json`
- **AND** Host SHALL NOT stop the owned official backend or other Codex processes in order to change accounts
- **AND** ordinary owned-backend start, stop, and remote connection SHALL remain available for non-switch work

#### Scenario: Isolated Web login does not restore multi-account management

- **WHEN** 用户从 Web Codex 设置为已配置的隔离 home 发起原生登录
- **THEN** 该 home 的原生 CLI SHALL 管理唯一当前认证及其存储，Host 只转交登录状态
- **AND** GUI Settings → Accounts SHALL 保持只读；GUI home、官方认证请求和旧账号方法 SHALL 不受影响
- **AND** Host MUST NOT 创建凭据副本、账号收藏、切换或退出功能
