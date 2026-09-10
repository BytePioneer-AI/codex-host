# Codex 账号设置

在 codexhost 的「设置 → 账号」管理当前 Host 的 Codex 账号。账号切换是 **Host 全局认证状态**：同一 Host 上所有官方 Codex Thread（包括已经存在的 Thread）始终使用当前账号，不存在按会话或草稿固定账号的路由。

## 运行模型

- 每个 Host 只有一个受所有者管理的官方 Codex app-server 和一个共享原生 `CODEX_HOME`。
- 切换账号会暂时关闭 Codex 工作准入，确认官方进程树退出，保存源账号的最新原生凭据，原子安装目标凭据，重新启动并验证身份，然后提交当前账号。
- 切换不会重启 Codex Desktop、codexhost Host、Mapping Store、委派服务或外部 Harness；Pi、Claude Code 等外部 Harness 的运行不因此结束。
- 已有 Codex Thread 保留原 Thread ID、历史、路径和运行设置。codexhost 不重放已完成 Turn，也不在 Thread 元数据中记录账号绑定。
- 切换中、仍有官方工作或恢复状态不确定时，请求会明确返回 busy/changing/unavailable，不隐藏排队或自动重放非幂等请求。

Windows Desktop 与本机 Remote Control 共享上述所有者、当前账号和官方后台。Linux/macOS 本地运行同样属于本地账号所有权；不能仅根据操作系统将其误判为 SSH。

SSH Host 保留服务器原生的单账号认证。SSH 对账号添加、登录、切换和删除返回明确不支持，不向本地传输远程凭据，也不创建本地账号槽位。

## 账号列表与额度

页面显示账号名称、邮箱、Codex 官方 `planType`、当前账号标记、额度、重置卡和操作。不会显示 `CODEX_HOME`、凭据槽位或其他私有路径。

- 「当前账号」是整个 Host 唯一的当前身份；「切换账号」不是“设为新任务默认账号”。
- 当前账号额度通过唯一官方后台读取；非当前账号参照 OpenCodex，使用严格私有凭据槽直接请求 WHAM。该读取不会切换共享 `auth.json`，也不会启动额外官方后台。
- 非当前凭据遇到过期或 401 时，Host 使用有界 OAuth 刷新、per-account single-flight、稳定身份复核和槽位摘要 CAS 写回旋转后的 Token；只有刷新／写回阶段进入全局 gate。切换 UI 只等待源账号与目标账号的在途读取，不等待整个账号库。
- 每个账号的成功额度都按稳定账号 ID 原子持久化并显示实时／上次确认时间。网络、认证或写回失败会保留 last-good 快照，不会改成伪造 0% 或清除其他账号额度。
- 额度列只展示 WHAM／原生接口实际返回的窗口，不补造缺少的窗口，也不合并各窗口百分比。
- 默认可按剩余或已用显示；风险颜色按已用比例判断，每个窗口保留自己的重置时间。
- `planType` 只用于显示，不用于推断 Model、Provider、产品能力或 Billing Source。
- 账号状态通知带单调修订号；多窗口和所有 Codex Composer 共享同一当前账号，并忽略旧代次结果。

## 添加、重新登录、取消和删除

添加与重新登录使用唯一官方后台的设备代码登录事务，不启动第二个认证后台。独立 OAuth 客户端仅属于非当前账号额度读取，不用于登录、模型请求、Thread 路由或自动账号切换。

1. 暂停新的 Codex 工作并确认原生状态空闲。
2. 停止官方进程树并保存当前账号的最新原生凭据。
3. 以同一所有者启动设备代码登录。
4. 仅在原生登录完成、凭据身份和认证就绪均验证后保存账号。
5. 已有源账号时保存新账号后恢复源账号，不自动全局切换；没有源账号时首次成功账号成为当前账号。重新登录同一身份会更新原条目而不是创建重复项。

取消、超时、失败或迟到事件不能热改当前身份。Host 会停止登录后台并从已确认的原生事实恢复源账号；无法确认恢复时仅将 Codex 标记为 unavailable，其他 Harness 与 Host 服务继续运行。

只允许删除非当前账号。删除仅移除该账号的私有凭据槽位和非秘密元数据，不删除共享 home、Thread 历史或附件；删除当前账号前必须显式切换。

共享 home 中的当前凭据仍由原生 Codex 维护；Host 只在确认官方进程树停止后转移当前凭据所有权。非当前槽位允许额度子系统刷新，但必须在全局 gate、per-account single-flight、身份复核和摘要 CAS 下原子写回。API Key、外部 Token、keyring 或无法验证权限的存储模式会在改写前禁用账号管理，不会静默修改原生配置。

Windows 上官方 `CODEX_HOME` 会为 `CodexSandboxUsers` 保留只读／遍历 ACL。codexhost 接受该原生边界以及从目录继承到 `auth.json` 的只读权限，但仍拒绝该主体的写入、删除、所有权或 DACL 修改权限，也拒绝 Everyone、Users、Authenticated Users 等宽泛读取。账号槽位、切换 Journal、迁移记录与备份继续位于严格私有账号目录；writer lock、官方进程 witness 和退出回执位于 `CODEX_HOME/.codexhost-native-accounts` 严格私有子目录，不继承 Sandbox ACL。

## 其他 Harness 的只读账号额度

同页的「其他已识别账号」可展示 Grok Build、Antigravity、Claude Code 等 Harness 通过自身原生接口提供的只读额度。这不是 Codex 多账号管理：不提供添加、删除、切换或重置操作，也不改变 Codex 当前账号。

公共链路是 `HarnessAdapter.inspectAccount()` → `codexhost/harness/accounts/list` → 设置页。快照只包含可展示身份、套餐和额度；不包含凭据、私有路径或原始 SDK 对象。单个 Harness 查询失败不会阻断其他 Harness。

## 迁移与回退

旧版按账号 `CODEX_HOME` 的 v1 布局必须先完成非破坏性盘点和迁移。迁移始终保留原目录作为一致性原件，并写入不含路径和凭据的私有迁移记录。

当前支持矩阵：

- 支持单一原生 home 原地采用。
- 多 home 迁移只在 native launcher 接管且其进程身份仍可确认时运行；直接启动 Host、旧进程树退出无法确认或 launcher 已消失时阻断 Codex。
- 支持次要 home 仅含凭据、生成缓存、日志、插件/Skill 缓存和空 bootstrap 数据库的快速路径。
- 支持复制 `sessions` 与 `archived_sessions` rollout；保持相对路径和文件字节。目标同路径同内容幂等跳过，不同内容阻断；中断后可依据源原件和迁移记录重试。
- `attachments`、`memories`、目标/队列、项目、Thread 关系、动态工具、artifact、远程 enrollment、外部配置导入、配置差异、未知顶层数据或无法读取的 SQLite/WAL 会阻断迁移，不合并原生数据库。
- 缺失或损坏凭据不会被虚构为已连接账号；可验证身份按用户＋工作区去重，原条目要求重新登录。

v2 一旦产生新工作，不允许通过整体目录回退覆盖共享 home。恢复只依据私有事务记录、当前原生文件、账号槽位和已确认的进程树退出事实；不会启用旧多后台 fallback。

## 相关实现

- `packages/host-runtime/src/codex-runtime/official-runtime-owner.ts`：单一官方所有者、多客户端协议隔离和 Thread 恢复。
- `packages/host-runtime/src/account/codex-account-switcher.ts`：全局切换、回滚和恢复事务。
- `packages/host-runtime/src/account/managed-codex-accounts.ts`：账号列表、登录、取消与删除。
- `packages/host-runtime/src/account/codex-credential-files.ts`：共享原生凭据与私有账号槽位。
- `packages/renderer-extension/src/renderer-codex-account-state.ts`：Host 全局账号快照与修订同步。
- `packages/renderer-extension/src/settings/accounts-page.ts`：账号设置界面。
- `packages/shared-contracts/src/codex-accounts.ts`：浏览器安全的 v2 账号契约。
