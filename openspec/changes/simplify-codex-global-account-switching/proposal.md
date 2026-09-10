## Why

产品需要的是“保存多个 Codex 账号、一次使用一个、切换后所有会话的后续请求使用新账号”，而不是不同账号并发运行。当前按账号拆分后台与 `CODEX_HOME`、固定绑定 Thread 的架构增加了路由、历史聚合和生命周期复杂度；实测还表明仅调用官方登录接口可能继续复用旧身份的模型 WebSocket，必须建立受控的停止、凭据替换、重启和身份确认流程。

## What Changes

- **BREAKING** 将 Codex 多账号由“新任务默认账号＋Thread 固定账号”改为“当前 Host 的全局当前账号”；保留多个账号的凭据，但最多运行一个官方 Codex 后台，所有官方 Thread 使用一个共享 `CODEX_HOME`。不同 Host 不互相切换，Harness 归属保持不变。
- **BREAKING** 删除 `CodexRuntimePool`、`AccountOfficialListeners`、Thread→Account 持久化绑定、跨账号历史发现、多账号官方列表聚合及 Composer 草稿账号覆盖，替换为一个可受控重启的官方后台生命周期；不保留旧架构作为并行运行模式。
- 切换时原子阻止新 Codex 工作进入，确认所有连接上的 Codex 工作空闲，停止并等待旧后台退出，保存最新凭据，换入目标凭据，重启并确认身份，再恢复原 Thread。Desktop、codexhost 和其他 Harness 不重启；预期退出及恢复失败不得触发 Host 全局清理。
- 保留添加账号、设备代码登录、取消、删除及查看账号能力；添加账号也使用唯一后台的独占认证事务，完成或取消后恢复原账号，不创建认证辅助后台。仅已确认登录的账号进入保存列表。
- 使用私有凭据存储、稳定用户身份与工作区关联、原子写入和小型恢复记录。官方后台继续维护当前账号的运行凭据；额度子系统参照 OpenCodex，为每个保存账号使用私有凭据直接读取 WHAM，并在需要时以 single-flight、generation/CAS 和原子写回刷新非当前账号 Token。
- **BREAKING** 设置页和 Codex 会话账号入口改为“当前账号／切换账号”，统一执行全局切换；所有相关窗口同步结果。活跃工作时拒绝切换、不强制中断；切换中的 Codex 请求明确失败或重试，不静默排队后以另一身份执行。
- **BREAKING** 重置卡消费仍只允许当前账号；额度读取改为 OpenCodex 风格的多账号直接查询：当前账号可通过官方后台读取，非当前账号使用其私有凭据请求 WHAM，不临时切换、不启动额外官方后台。所有账号保留 last-good 持久快照与获取时间，失败不得清除已有成功数据。其他 Harness 的只读账号额度保持现状。
- SSH / Unix 远程 Host 明确维持单个原生账号：可查看身份与额度，但前后端都禁用账号库管理和全局切换；Windows 本地 Desktop / Remote Control 连接共享同一个本地切换事务，不因存在远程控制连接而误判为 SSH Host。
- 对现有布局执行一次性、可验证、非破坏迁移：优先保留原生 home，导入凭据及受支持历史，完成后退出所有旧账号路由；不能安全迁移的数据明确阻断迁移完成，不默默丢弃或退回多后台架构。

## Capabilities

### New Capabilities

- `codex-global-account-switching`: 单后台全局账号语义、受控重启、Desktop 与其他 Harness 生命周期隔离、多连接协调、账号 UI 和实时额度范围。
- `codex-account-credential-lifecycle`: 凭据保管、用户／工作区身份、原生刷新归属、添加登录、取消删除、失败回滚和崩溃恢复。
- `codex-account-layout-migration`: 旧多 home 数据迁移、完整性检查、冲突阻断、备份保留及旧运行时代码删除的完成标准。

### Modified Capabilities

- `remote-ssh-harness-host`: 增加 SSH Host 原生单账号的显式能力与服务端限制；保留一个共享官方监听器、SSH 隔离与现有外部 Harness 执行行为。

## Impact

- Host：`packages/host-runtime/src/account/`、`codex-runtime/`、`app-server-host.ts`、`run-host-runtime.ts`、官方连接／请求生命周期、账号登录、Thread 列表和额度投影；删除仅服务于多账号后台的模块与出口。
- 公共契约：`packages/shared-contracts/src/codex-accounts.ts`、Thread inspection 契约和 Renderer 客户端；版本化当前账号、操作能力、切换状态／错误及快照新鲜度，删除 per-Thread Account 路由语义。旧客户端不得通过旧 `activate` 或隐藏参数绕过切换边界。
- Renderer / Desktop Control：设置页、账号选择、Thread 身份与用量显示、`agent-selection-state.ts`、`renderer-binding-probe.ts`、`renderer-draft-prewarm-runtime.ts` 及其版本绑定；Harness 选择和原生会话功能保持独立。
- 持久化：账号元数据升级、私有凭据快照、共享 home、一次性旧布局读取与迁移记录；不删除用户旧 home，不把外部 Harness Mapping Store 当作多账号遗留数据清理。
- Native：只有确有需要的进程退出确认与文件权限原语属于 Rust / platform；账号策略、协议重连和 OAuth 语义不得移入 Rust。无预定 Harness SDK 或依赖升级。
- 验证：复用仓库配置增加聚焦单元、协议、多客户端和 Desktop E2E 测试；Windows 已有可行性证据，但真实 Token 轮换、完整附加历史数据、无 Desktop 重启的集成流程及 Linux/macOS 仍是实现验收门槛。详见本 change 的 `evidence.md`。
