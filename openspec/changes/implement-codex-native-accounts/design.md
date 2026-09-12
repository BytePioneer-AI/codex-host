## Context

完整设计和参考取舍见 [Codex 原生账号切换设计](../../../docs/codex-native-account-switching-design.md)。此 change 是已授权实施记录，不是新一轮待批准设计，也不是发布完成声明。

## Decisions

1. **两个主要 Module**：`CodexAccountControl` 表达业务操作，`OfficialRuntimeOwner` 表达唯一官方实例。Vault、纯恢复决策和事务是账号 Module 的内部实现；不建立第二套登录回滚或通用工作流框架。
2. **一个提交点**：Vault 包含 revision、lastOperationId、current 和非当前密文。当前 payload 为空，实际原生文件是当前凭据权威；Journal 的 before/after 和加密 source/target 决定恢复，不能根据最后一次 await 是否抛错判断提交。
3. **原生认证验证**：先确认旧进程树退出，再原子安装；新进程使用 `account/read` 和原生受认证额度读取，不发起 Model Turn。JWT 仅做身份关联。
4. **隔离登录**：登记 operation 后创建短命目录和最小配置；只有认证后台，随后确认停止并读取最新凭据。设置页添加与原生 OAuth／设备代码登录共用同一事务；原生激活意图持久保留。Native completion Promise 保证启动应答先于完成事件，取消返回原生 status；正式后台的新 generation 通过真实 account/read 发布 account/updated，不投递 staging 身份。取消与启动 barrier、native loginId、generation 关联，避免迟到事件或去重后的 accountId 误配。
5. **稳定私有租约**：持锁 helper 同时执行后续有界 I/O，所有 facade 共享队列和关闭状态；操作前后验证路径身份。原生进程 receipt 不明时不能退休工作或释放安全租约。OS 密钥不可用不回退明文。
6. **能力与健康分离**：clean 状态下因版本、存储或密钥限制可保留原生单账号；关键恢复事实或所有权不明则仅 Codex unavailable。此时活着的 Host 仍可应答自身 transport initialize，保留 Desktop attachment 和原生协商参数；不发布假的认证或把客户端连接到 staging。活的管理器可 recover；静态不可用控制不伪造重试能力。
7. **独立额度职责**：当前走官方协议，非当前 direct WHAM。刷新 single-flight＋工作准入＋最新 Vault CAS；缓存重试只合并本账号补丁，不覆盖其他账号数据。
8. **迁移不冒充完成**：只有单一正式 home 原地采用。多 home、foreign home、孤立绑定或损坏记录保留原件并返回 migration-required；没有 rollout-only 自动迁移或旧后台池 fallback。有效多 home 若选中的账号已使用正式 home、全部旧 home 无托管状态且无其他 writer，则仅保留该 home 的原生单后台认证，不初始化 Vault／OS 密钥，禁用新账号管理。每次启动复查准入；设置页明确其他目录的历史尚未合并、需使用旧版访问。

## Source and licenses

核心参考 opencodex commit `2d4d7a22381a2e497c2442902104619e25f937c7`。保留 `third-party/opencodex.LICENSE`，installer/npm notice 包含原 MIT 文本和来源 commit。PR #252 的原语、测试及 UI 选择性复用，不以该 PR 的恢复协调层为新架构。

## Risks and validation

实际 OS keyring 授权、Windows DACL／Job 运行语义、真实 Desktop 和账号 A→B→A、全部原生设置恢复及完整旧数据迁移不能由内存 fixture 证明。验证区分 schema、合成行为、实际 helper 和真实产品验收四层；详见 `evidence.md`。同 UID 外部程序的任意文件写入不在 Host 租约强制防护范围内，检测到冲突只拒绝，不杀未知进程。
