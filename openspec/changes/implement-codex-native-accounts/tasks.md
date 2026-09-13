## 1. 平台与边界

- [x] 1.1 使用公共 Workspace 契约；Rust 只拥有通用原生能力，Renderer 不接触凭据。
- [x] 1.2 私有文件 helper 持锁执行有界 I/O，校验路径身份、权限和条件写入。
- [x] 1.3 提供进程身份、监督、退出 receipt 和单批次 Codex 后端终止。
- [x] 1.4 显式传递 home／profile 路径和 Chromium user-data-dir。
- [x] 1.5 复用代码附带 opencodex 来源和 MIT 发行声明。

## 2. 账号核心

- [x] 2.1 明文 Vault、Journal 与登录 candidate 保存完整原生凭据字节。
- [x] 2.2 旧密文使用已有密钥原地转换；按文件 CAS，可恢复部分转换。
- [x] 2.3 切换、首次激活、重登和退出共用一个事务执行者及提交收据。
- [x] 2.4 先进入 changing，再停止受管和检测到的其他 Codex 后端；新请求立即拒绝，不排队或重放。
- [x] 2.5 登录、退出及凭据接入保留空闲准入；独立 Host 刷新租约、身份和退出证明保护写入。
- [x] 2.6 原生 OAuth／设备代码登录使用唯一 staging 后台，关联开始、取消和完成事件，持久保留激活意图。
- [x] 2.7 冷启动先恢复后导入，允许外部 Codex 共存；不支持管理时按所有权事实选择原生路径。
- [x] 2.8 管理连接优先初始化，generation 隔离，Host transport initialize 独立于 Codex readiness。

## 3. Desktop 与额度

- [x] 3.1 v2 快照、全局设置页、Host instance/revision、只读 Composer 身份。
- [x] 3.2 原 Client 拥有在途应答；切换成功后通过原生入口恢复选中 Thread。
- [x] 3.3 原生订阅懒恢复，空闲路径采集的有效设置在恢复时验证。
- [x] 3.4 当前原生额度及非当前 WHAM／OAuth 刷新使用 single-flight、修改租约和最新 Vault CAS。
- [x] 3.5 旧布局凭据只读接入；主账号历史保持，其他 home 保留且不合并。

## 4. 验收

- [x] 4.1 提供契约、账号事务、RPC 退休、登录取消、恢复及 UI 的聚焦测试。
- [x] 4.2 完成类型、lint、边界、格式、聚焦 TS／E2E／Rust 和 OpenSpec 检查；结果与跳过条件见 evidence。
- [ ] 4.3 完成各目标平台的原生文件、进程树、旧密钥读取失败和 Desktop 联合运行验证。
- [ ] 4.4 实机验证检测到的 VS Code／CLI 后端 PID／启动身份退出及自动重启行为。
- [ ] 4.5 同一真实 Thread 完成 A→B→A，验证后续请求认证、历史、Desktop／Host 连续性及其他 Harness 行为。
- [ ] 4.6 完成当前支持矩阵验收后再进入发布。

结果与未验证边界见 [evidence.md](evidence.md)。真实账号、进程和发布操作须在获得相应授权后执行。
