## Context

完整设计见 [Codex 原生账号管理](../../../docs/codex-native-account-switching-design.md)。账号表示认证身份，正式 home 和官方 Thread 存储固定，其他 Harness 使用各自原生接口。

## Decisions

1. **单个受管后台**：`OfficialRuntimeOwner` 统一拥有管理和 Desktop 连接、工作准入、generation 与订阅；任务和认证 staging 不并行。
2. **统一事务**：`NativeCodexAccounts` 负责操作归属，`NativeProfileTransaction` 执行切换、激活、重登、退出和恢复。Vault 的 revision、current、lastOperationId 与 Journal 共同表达持久事实。
3. **中断切换**：进入 changing，停止受管及当次检测到的其他 Codex 后端，安装凭据并重启验证。新请求立即拒绝，旧 RPC 明确失败，不排队或重放；不扫描会话是否空闲。
4. **有限外部终止**：跨 CODEX_HOME 匹配 Codex 可执行文件名，核对 PID／启动身份后有界终止；不关闭编辑器、不递归停止外部工具子进程、不追杀自动重启实例。启动、普通关闭、回滚和恢复不执行此批次。
5. **私有明文存储**：完整凭据字节保存在 Vault、Journal 和 staging 中，受权限、租约、容量及 CAS 保护。旧密文使用已有密钥原地转换，失败保留原数据，部分转换可恢复。
6. **事实验证**：确认旧后台退出后才写凭据；新后台通过原生身份和认证接口验证后才提交。独立 Host 凭据刷新租约不得强制清空，文件或身份冲突不覆盖。
7. **隔离登录**：设置页添加 B 保持 A，原生登录激活新身份；同一 staging／事务持久记录意图。启动、取消、完成事件关联 operationId、native loginId 与 generation。
8. **能力与健康分离**：启动允许外部客户端共存，所有权和布局事实决定恢复。Host transport initialize 独立于 Codex readiness，不将客户端连接到 staging，不因 Codex 故障关闭其他 Harness。
9. **Thread 连续性**：原 ID 懒恢复，空闲操作采集的有效设置在恢复时验证。切换不采集设置快照，临时内容及完整运行时设置无损恢复不作保证。
10. **响应和导航**：在途 Host 应答属于原 Request Client，不重新发起账号操作。切换成功后，发起窗口通过原生入口打开先前选中的同一 Thread；超时、卸载或用户导航结束恢复。
11. **额度**：当前走官方协议，非当前走 WHAM。OAuth 刷新使用 single-flight、修改租约、身份校验和最新 Vault CAS，失败保留 last-good。
12. **凭据接入**：有效旧登记当前账号使用正式 home 时，只读导入缺失凭据和来源摘要；源文件与历史保留，其他 home 不合并。

## Source and licenses

参考 opencodex `2d4d7a22381a2e497c2442902104619e25f937c7` 的原生凭据事务、恢复和隔离登录。复用代码保留 `third-party/opencodex.LICENSE`，installer/npm notice 包含 MIT 文本和来源。

## Risks and validation

Host 租约不能阻止任意同用户程序写共享凭据。目标认证和文件验证不等于全部客户端同步身份。真实账号、OS 密钥、各平台文件与进程语义、Desktop 联合运行不能由内存 fixture 证明；当前状态见 `evidence.md`。
