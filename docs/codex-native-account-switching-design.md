# Codex 原生账号管理

## 1. 范围与支持条件

codexhost 在固定的正式 `CODEX_HOME` 中管理全局 Codex 身份，使用一份官方会话存储、最多一个存活的受管官方 app-server，以及本机私有账号 Vault。Account 表示认证身份，不等于 Harness、Model、Provider 或 Billing Source。

托管路径支持官方 `0.153.4` 与 `0.154.0-alpha.6.2` 的文件式 ChatGPT 登录。版本检查保留 prerelease 后缀。SSH 使用远端原生单账号，不传输本地凭据。产品仍处于验收阶段，支持矩阵与运行验证见 [验证状态](../openspec/changes/implement-codex-native-accounts/evidence.md)。

## 2. 用户行为

- 设置页提供全局切换。已有 Codex Thread 的后续请求使用当前账号；Thread ID、已持久化历史和 Harness 归属保持。已有上下文可用于新账号的请求，账号不是独立的数据空间。
- 切换会中断本机 Codex 后端，包括不同 `CODEX_HOME` 下的 VS Code／CLI 后端。设置页提示任务和未保存内容可能丢失，点击切换没有额外确认弹窗。
- Desktop、Host、编辑器及其他 Harness 不因切换重启。外部后端的工具子进程不递归终止，工具副作用不保证停止或回滚。
- 启动允许与 VS Code／CLI 共存，不枚举或停止外部 Codex 后端。布局、来源、凭据和自身进程恢复记录仍须验证。
- 添加账号使用原生设备代码登录。当前为 A 时添加 B 只保存 B，完成后继续使用 A；未登录时首次成功登录成为当前账号。Desktop 原生登录则使用本次登录身份。
- 登录、退出登录和凭据接入要求相应工作空闲。删除只允许非当前保存账号，并保留确认；不删除 Thread、home 或源目录。退出登录保存当前最新授权并清除运行身份，保存账号仍可再次选择。
- Harness picker 只有一个 Codex；Composer 可只读显示当前身份，不提交 per-draft 账号选择。

从源码构建启动使用 `npm start`；macOS／Windows 启动脚本会停止正在运行的 Desktop。

## 3. 职责与公共边界

```text
Desktop / 设置页 / Host 内部委派
                 │
           AppServerHost
          ┌──────┴────────┐
       账号操作          原生工作
          │               │
  NativeCodexAccounts   OfficialRuntimeOwner
          │               │
   Vault / 事务 / 登录   准入 / 代次 / 订阅
          └──────┬────────┘
         Rust 通用平台原语
       私有文件 / 旧密钥读取 / 进程监督
```

- `CodexAccountControl` 提供快照、切换、登录、取消、删除、退出和恢复。调用者不传入凭据或文件路径，不控制 Journal 阶段。
- `NativeCodexAccounts` 拥有操作归属、登录意图及恢复协调。`NativeProfileTransaction` 是切换、首次激活、重登和退出的统一事务执行者。
- `OfficialRuntimeOwner` 拥有唯一受管后台、管理及任务连接、工作准入、generation 与原生订阅。所有 Desktop 和 Host 委派共享同一准入边界。
- `ManagedNativeAuth` 处理 Desktop 原生认证响应及事件投递，不拥有凭据事务。
- `host-runtime` 拥有账号、OAuth、凭据格式与原生协议语义。Rust 只提供通用文件、密钥读取和进程能力。
- `shared-contracts` 提供浏览器安全状态；Renderer 只显示、提交操作和处理状态修订，不接触 Token、私有路径、Harness SDK 或原生连接。
- 非当前额度与旧布局接入是独立职责，不进入每个 Codex 工作请求的路径。

## 4. 凭据与私有存储

正式 home 固定。当前凭据以原生 `auth.json` 为权威，非当前凭据以 `.codexhost-native-accounts/vault.json` 为权威。Vault 原子保存账号元数据、current、revision、lastOperationId 和非当前 payload；当前账号的 payload 为空。

payload 使用 `{ format: "plaintext", nativeDocument, digest }`。Vault、Journal、登录 candidate 及 staging 文件均是敏感明文。保留完整原生字节和未知字段，不重建等价文档。身份使用 issuer、稳定用户标识及 workspace 关联；JWT 解码和邮箱不能替代原生认证验证。

### 权限、容量与并发

- 私有文件 helper 在同一进程中持锁并串行执行 I/O。只读目录 facade 共享租约、64 项有界队列和关闭状态；操作前后核对路径身份。
- Windows 校验 DACL；macOS 拒绝非空扩展 ACL。退出未确认时不能释放受控写入者的租约。
- 写入使用预期摘要和原子替换。Vault 并发修改基于最新状态合并目标账号，不覆盖其他账号变更。
- 单凭据上限 256 KiB，Vault 4 MiB，Journal 17 MiB，通用私有文件 20 MiB，IPC frame 为文件预算四倍加 16 KiB。最多 128 个账号，同时受字节预算约束。
- Renderer、日志、命令参数和普通元数据不携带凭据。公开错误只返回稳定类别和固定提示。
- 删除文件不等于在 SSD 或快照中物理擦除。任何有权读取私有文件的程序都可能取得凭据。

### 旧密文转换

`legacy-credential-migration.ts` 在正式 home 租约下读取 Vault、transaction 和 login 文件。存在 AES payload 时读取已有 OS 密钥，验证全部解密结果、身份、摘要和容量后，按文件 CAS 转换。原 `auth.json`、账号 ID、current、revision、事务阶段及凭据字节保持。

部分转换可在下次启动继续；密钥缺失、授权失败或数据损坏时保留原数据并报告错误。明文库不访问 OS 密钥，生产接口只提供旧密钥读取。旧 OS 条目保留以支持尚需解密的备份。

## 5. 运行时与启动

本地托管模式使用官方受保护 loopback listener：回环地址、动态端口和 capability-token 认证。令牌只在 Host 内存中，启动参数仅携带官方要求的摘要。一个进程支持管理连接和多个 Desktop 连接；模型网络请求由官方 Codex 自己发起。

1. 接通 Host 控制面，官方工作保持不可用。Codex 故障不触发其他 Harness 的全局清理。
2. 解析规范化 home，取得租约，检查自身进程记录、Vault、Journal 和 staging；先恢复，再考虑首次凭据导入。
3. 如需读取有效配置，以唯一管理后台探测，不恢复用户工作。需要写凭据时先确认后台退出。
4. 根据文件、身份、摘要和提交事实完成恢复，启动正式后台，初始化管理连接并验证认证。
5. 准入开放后，Desktop 客户端按保留的初始化参数连接。

Host transport initialize 独立于 Codex readiness：在 changing／unavailable 时只返回 Host 身份、正式 home 和平台元数据，保留客户端协商，不接入 staging、不宣称认证成功。已终止的客户端不接受新初始化。

无未决事务或所有权冲突，仅因版本、存储或旧密钥能力不支持管理时，可提供安全的原生单账号路径。关键事实不明时仅 Codex unavailable；只有具备恢复能力的控制器才公开 recover。

## 6. 切换事务

```text
进入 changing，拒绝新工作和重复切换
  → 预检目标凭据、存储和来源身份
  → 停止受管后台，确认整个受控进程树退出
  → 停止当次检测到的其他 Codex 后端
  → 确认独立 Host 凭据刷新租约已结束
  → 读取实际最新源凭据，核对身份
  → 写 prepared Journal：源／目标、before／after Vault
  → 原子安装目标并读回校验，写 auth-replaced
  → 启动唯一正式后台，原生验证目标身份与认证
  → 原子提交 Vault，写 vault-committed 并清理
  → 开放工作，发布确认状态
```

切换不扫描 Thread、Goal、队列或临时会话，不等待额度查询。旧原生 RPC 随连接退休明确失败并释放各自租约；主动停止不因未完成额度请求而破坏 changing 状态。新 RPC 在连接和自动启动之前拒绝，不排队、不自动重放。独立 Host 凭据刷新不能靠清空租约强制结束。

外部停止 helper 按官方可执行文件 basename、`codex`、`codex.exe` 精确匹配，记录 PID／启动身份。先终止并等待 2 秒，仍存活则强制终止并再等待 2 秒。只处理当次批次，不追杀 IDE 自动拉起的新进程。启动、普通关闭、回滚和恢复不调用外部停止 helper。

Host 的锁不能阻止其他客户端以后写共享凭据。成功要求目标文件身份和受管后台认证验证通过，不要求所有客户端同步身份；这不是多客户端原子切换协议。

### 失败与恢复

| 事实 | 处理 |
| --- | --- |
| 后台退出无法确认 | 不安装目标，不启动竞争后台；受管退出不明则 unavailable |
| 文件仍是源且目标未提交 | 保留源的最新凭据，验证恢复源运行 |
| 目标已安装但未提交 | 操作失败时停止目标并保全最新授权，恢复源；崩溃恢复按持久意图验证目标或补偿 |
| Vault 已提交，Journal 或清理未完成 | 提交收据为准，保留已提交身份；不能安全收尾则关闭准入 |
| 第三方身份、无法解释的摘要或 Journal 不匹配 | 不覆盖文件，保留记录并要求恢复 |
| 同身份重登 | 依据字节摘要和安装事实区分授权版本，不降级原生轮换后的 Token |

任何可能刷新目标 Token 的启动之前须持久化安装阶段。`lastOperationId` 是 Vault 提交收据；补偿前持久保存最新目标和 rollback 意图。recover 根据事实执行同一事务，不删除 Journal 来假装成功。认证验证使用原生接口，不发送 Model Turn。

## 7. 登录与退出

登录要求空闲，停止任务后台后在私有短命 staging 目录启动唯一认证后台。staging 只继承最小认证配置，不包含用户任务、插件或 Thread。确认本次原生登录完成后，停止认证进程树，读取最后落盘凭据并核对用户及 workspace。

- 设置页添加 B 时 A 的正式凭据保持不变；保存 B 后恢复 A。无当前账号时通过统一事务安装首次身份。
- 非当前账号重登只更新对应 payload。当前账号重登及 Desktop 原生登录通过统一事务安装新授权；staging 持久记录 `activateOnSuccess`。
- 取消、超时和迟到事件关联 operationId、原生 loginId 和 generation。先结束登录后台再清理；迟到写入仅能落在该 staging。
- 已保存但清理／正式后台恢复失败时显示已保存及待恢复，不把它当成尚未保存。
- Desktop ChatGPT OAuth／设备代码参数保持原生语义；启动应答先于完成事件，取消返回原生 status，正式后台就绪才发布成功。
- 正式 generation 的 `account/updated` 来自其真实 `account/read`；慢客户端或观察者失败不回滚已提交凭据。
- 退出登录是以无凭据为目标的事务：空闲后停止、保存最新授权、清除正式凭据、启动验证并提交 current=null。

## 8. Thread、响应与公开状态

每次后台替换形成新 generation。退休代次的响应、审批和通知不能更新新代次。确认进程退出后通知附着客户端结算工作；EOF 或客户端 detach 不等于退出证明。

Owner 保留原生初始化和订阅参数，后续请求按原 ID 懒恢复，不复制历史或重放 Turn。登录、退出等空闲路径通过原生接口检查工作和可恢复性、采集有效设置并在恢复时验证。切换不采集此快照，临时内容及完整运行时设置的无损恢复不作保证；恢复失败明确报告，不伪造替代 Thread。

Renderer 记录切换发起窗口中选中的本地 Codex Thread。成功后等待界面可用，经原生入口打开同一 Thread 一次；拒绝、超时、用户导航或卸载结束恢复。Desktop 更换 Request Client 时，在途应答归原请求所有者，不重新发送账号操作。

v2 快照包含 `ready/changing/unavailable`、Host instance、revision、已提交 current、能力、账号列表及必要的操作／清理状态。UI 以 Host 身份与单调 revision 接收更新；current 不等于后台已就绪。busy 是操作错误，不是持久账号状态。账号 API 为 list、switch、login/start、login/cancel、delete、logout、recover；activate 和 per-draft 账号输入明确拒绝。

## 9. 额度与旧布局

当前额度走正式原生后台；非当前额度由 Host 直接查询 WHAM，不启动额外后台或隐式切换。OAuth 刷新使用每账号 single-flight、修改租约、身份复核和最新 Vault CAS。失败保留 last-good 和获取时间，不补零。只有当前账号能消费重置卡，消费请求不自动重试。Thread 累计用量与账号额度分离。

有效旧登记的当前账号已使用正式 home，且其他 home 无托管状态或进程记录时，可以在恢复、原生验证及退出确认后只读接入缺失凭据。单次 Vault CAS 同时保存账号及 `legacyRegistryDigest`，不覆盖已有授权，不因重启复活已删除账号。正式 home 的托管状态走正常恢复；损坏登记、foreign home、孤立绑定和未知退出状态不绕过校验。

主账号使用原正式 home 的历史；其他 home 的历史、附件、记忆、队列、项目和数据库原样保留，不合并或自动删除。`legacyHistoryPreserved` 表示凭据已接入而历史未合并，不宣称完成历史迁移。

## 10. 来源与验证

凭据事务、恢复和隔离登录参考 opencodex `2d4d7a22381a2e497c2442902104619e25f937c7`。复用代码保留 [MIT 许可证](../third-party/opencodex.LICENSE)，发行包包含来源声明。reference 仓库不是构建或运行时依赖。

验证覆盖公开契约、事务故障、真实原语和产品行为，分层结果不可互相替代。平台运行、真实账号 A→B→A、后续请求认证及外部 Harness 联合行为的验收状态见 [验证状态](../openspec/changes/implement-codex-native-accounts/evidence.md)；实施范围见 [任务清单](../openspec/changes/implement-codex-native-accounts/tasks.md)。
