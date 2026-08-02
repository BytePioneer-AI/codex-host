## 1. 最小 Adapter 契约

- [ ] 1.1 在 Shared Contracts 与 HarnessAdapter 中增加 `history.rollbackLastTurn` 和 `open(rollbackLastTurn)`，保持现有 create/resume/fork 输入不变，并让未实现 Adapter 与 Fake 默认诚实报告 false
- [ ] 1.2 增加聚焦的 Schema/Fake 契约测试，覆盖 true 能力解析、false 时 unsupported 和空/活动来源拒绝，不扩展通用 Rewind API

## 2. Pi Native 派生

- [ ] 2.1 在 PiAdapter 中通过原生 `--fork` 加 RPC `fork(lastUserEntryId)` 实现最后一轮之前的独立 Session，验证 distinct identity、同 cwd、精确短一轮 Snapshot 和来源不变
- [ ] 2.2 增加两个 PiAdapter 聚焦用例：两轮变一轮、单轮变零轮且新 Session 可继续；不增加任意节点或真实模型矩阵

## 3. 原子持久化与 Host 路由

- [ ] 3.1 为 Mapping Store 和 ExternalThreadRepository 增加专用最后一轮 ready Session 原子替换，允许空 mappings、复用保留 Host Turn IDs、保持 Fork/管理元数据，并在失败时保留旧记录和索引
- [ ] 3.2 重构 External rollback 分类，使现有 eligible post-Fork 路径保持优先，并仅在其不适用时为 capable ready Thread 接入 `numTurns=1` 的 rollbackLastTurn 路径
- [ ] 3.3 完成新 Session Snapshot 验证、同 Host Thread 响应投影、提交后 Runtime 替换和失败时新 Runtime 关闭，确保请求不进入官方 Codex且不修改文件
- [ ] 3.4 增加聚焦 Store/Host 测试：普通两轮删除末轮、首轮删除为空、写盘失败保持旧状态、普通多轮/unsupported 拒绝；复跑现有 post-Fork rollback 与官方透传用例

## 4. 基线与验收

- [ ] 4.1 更新 PRD、架构、HarnessAdapter、持久化和开发清单中的最后消息编辑边界，明确 Renderer 零修改、Pi-only、单轮和不回滚文件
- [ ] 4.2 运行受影响包测试与类型/格式检查、`git diff --check` 和 strict OpenSpec validation，不为本 Change 扩建全量或性能测试
- [ ] 4.3 在受控 Windows Codex Desktop `26.727.40816` 完成一次 Pi 文本末轮编辑并重发 Gate，记录同 Host Thread、历史短一轮后继续、无官方 Codex 路由和文件不变的脱敏结论
