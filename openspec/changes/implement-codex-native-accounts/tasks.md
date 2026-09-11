## 1. 基线与边界

- [x] 1.1 从 `9d22515ec63d5ff79eec4a12d6d56b721b2bd361` 建立独立 worktree 和实现分支，不在原 checkout 实现。
- [x] 1.2 以 opencodex native profile 为核心参考，选择性复用 #252；保留 MIT 来源并加入 installer/npm notices。
- [x] 1.3 保留公共 Workspace 边界，不在 Rust 引入 Account/OAuth/Thread 逻辑，不在 Renderer 引入原生 SDK。

## 2. 原生平台与进程所有权

- [x] 2.1 实现私有文件、OS 32-byte 密钥、进程身份与有界进程盘点、进程监督与退出 receipt。
- [x] 2.2 持锁 helper 执行全部后续 I/O；共享 facade、64 项队列、20 MiB 文件预算和稳定路径校验。
- [x] 2.3 验证 macOS 实际 helper／扩展 ACL 拒绝，完成 Windows/Linux 平台编译检查；不将编译等同于运行验证。
- [x] 2.4 在 spawn intent 写入后重新检查租约；Scope 关闭后拒绝迟到启动，失败 close 的每次重试仍须证明退出。

## 3. 账号与 Runtime 核心

- [x] 3.1 统一 Vault、加密 Journal、原生完整字节、同身份摘要判定及提交收据。
- [x] 3.2 切换、首次激活、当前重登和 logout 共用一个事务执行者；补偿前保全最新目标。
- [x] 3.3 实现认证-only staging、启动／取消 barrier、早晚事件关联、去重和已保存但待恢复结果。
- [x] 3.4 冷启动先恢复后导入；未知身份先拒绝；clean 不支持能力保留原生单账号与安全所有权。
- [x] 3.5 唯一官方 Owner，管理连接优先初始化，工作准入与 generation 隔离；只在实际退出确认后退休工作。
- [x] 3.6 捕获原生有效设置，懒恢复并验证；连续无工作代次仍保留设置；拒绝临时／缺少持久路径的 Thread。
- [x] 3.7 unavailable 恢复可重试旧进程退出证明，但不得清空未确认工作、打断健康的 busy 运行或越过在途凭据刷新。
- [x] 3.8 本地／Remote Control 共享一个 Scope；SSH 保持远端原生认证；Codex 故障不关闭外部 Harness。

## 4. UI、额度与升级

- [x] 4.1 接入 v2 快照、全局 Settings 操作、Host epoch/revision 和只读 Composer 身份；删除旧选择和路由代码。
- [x] 4.2 完成前端登录早事件、重登不以旧邮箱判断成功、无邮箱保存账号和结果未确认显示的最后回归。
- [x] 4.3 保留非当前 WHAM／OAuth 刷新、single-flight、最新 Vault CAS 和按账号补丁的缓存重试。
- [x] 4.4 实现旧布局有界只读检测，单 home 原地采用，多 home／foreign／损坏／孤立绑定明确阻断并保留原件。
- [ ] 4.5 在另行确认阶段和采集值后设计人类迁移流程；实现并验证旧多 home 数据库、附件、记忆、队列与项目关系的完整迁移。

## 5. 验证与发布门槛

- [x] 5.1 添加公共 Interface 组合测试及真实 compiled-helper 合成测试；修复持久提交、退出、恢复和连续切换的边界回归。
- [x] 5.2 在全部最后修正后重跑类型、lint、边界、格式、聚焦 TS/Renderer/E2E、Rust 与 OpenSpec 验证，并更新证据。
- [ ] 5.3 获得授权后，完成真实 OS keyring 生命周期、各平台 native 文件／进程树及 Desktop 联合验证。
- [ ] 5.4 获得授权后，同一真实 Thread 完成 A→B→A，并验证 Desktop/Host PID 和外部 Harness 流式输出、审批、取消、保存不中断。
- [ ] 5.5 证明官方默认凭据存储及更广版本／配置矩阵后，再扩展当前明确 `file` 的能力限制。
- [ ] 5.6 完整迁移和上述门槛闭合后，才可宣称替代旧版本并进入发布；用户已另行授权提交、推送和审查 PR，但未授权发布。

执行记录和限制见 [evidence.md](evidence.md)。未勾选的发布门槛不是测试已通过，也不授权真实账号操作或编写未经确认的迁移向导。
