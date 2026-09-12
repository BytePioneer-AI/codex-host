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
8. **凭据接入不冒充历史迁移**：有效多 home 登记当前账号已使用正式 home 时，在原生身份／file 存储验证及退出证明后，只读导入缺失身份到加密 Vault；同一次 CAS 记录来源摘要。已有保存授权不被旧源覆盖，删除后的账号不因重启复活。当前 home 的托管状态走正式恢复，其他 home 的托管状态、foreign home、孤立绑定或损坏登记仍拒绝。历史文件和旧登记不改写，不恢复后台池；UI 明确其他历史尚未合并。按用户后续确认，当前只保全主账号原正式 home 的历史，不要求迁移、合并或展示其他旧账号历史，也不主动删除旧目录。
9. **普通原生使用与凭据变更分开准入**：干净未托管 home 的其他 CLI 不使 Desktop 启动失败，但此模式不初始化 Vault／密钥，禁止导入、切换和原生登录／退出。未知 writer 仍阻止凭据替换；有托管状态或旧进程记录时不使用该模式。

10. **在途响应归原 Client**：Desktop 可在账号更新后更换内部 Request Client，并按当前 Host Client 投递响应。已提交 Fiber 发现及固定 policy 所有权检查约束新请求；以每次遍历最多 20,000 节点和环检测限制工作量，不要求合法历史页面在 200 层内到达根节点；在途 Host 请求则由原生 lifecycle 记录 ID，在正常投递未完成原 Promise 时交回原 Client 的原生响应 API。保留 Host／ID／窗口来源边界、原始结果和 metrics，退休后仅排空已有响应，不创建新请求或修改账号事务。

11. **会话 ID 跨界面重建保留**：用户确认最小流程为记住当前会话、切账号、新界面可用后打开同一会话。仅捕获当前窗口中归属明确的本地 Codex Thread；成功后等待旧 Composer 移除、新 Composer 出现，再调用已有原生侧栏打开入口一次。界面等待预算从切换应答后开始，拒绝、用户在 Settings 外交互、其他会话已选中、超时或卸载均结束恢复。不修改官方路由器、保存整套界面状态、建立 Account→Thread 映射或重发工作。

## Source and licenses

核心参考 opencodex commit `2d4d7a22381a2e497c2442902104619e25f937c7`。保留 `third-party/opencodex.LICENSE`，installer/npm notice 包含原 MIT 文本和来源 commit。PR #252 的原语、测试及 UI 选择性复用，不以该 PR 的恢复协调层为新架构。

## Risks and validation

实际 OS keyring 授权、Windows DACL／Job 运行语义、真实 Desktop 和账号 A→B→A、全部原生设置恢复不能由内存 fixture 证明。完整多 home 历史迁移已按用户确认移出当前交付范围。验证区分 schema、合成行为、实际 helper 和真实产品验收四层；详见 `evidence.md`。同 UID 外部程序的任意文件写入不在 Host 租约强制防护范围内，检测到冲突只拒绝，不杀未知进程。
