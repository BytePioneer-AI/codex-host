# Antigravity 原生回合结果核验

agy 的 `result.status = ERROR` 有时携带此前回合的 `error_message`。在 agy 1.2.13 的原生记录中，旧额度错误仍在历史步骤，而当前回合已经新增输入、工具执行及完成的 Planner Response。直接采用该汇总会让 Host 把新回合也记录为失败。

Adapter 在恢复会话、发送输入前，只读记录原生 SQLite 的步骤和生成元数据边界。收到错误结果后，只有以下证据同时成立才采用当前原生回合的成功状态：

- Conversation 数据库身份和结果身份一致，原生用户回合数只增加一次。
- 边界后恰好出现一个新输入；当前步骤全部完成，没有 Error Message 或错误详情。
- 当前最后一步是完成的 Planner Response，并包含当前流式回复的前缀。
- 汇总报告的错误实际存在于旧回合，当前新增的 Generator / Executor 元数据中没有错误字段，即便新错误与汇总文字不同也不能恢复。

经过核验的旧错误汇总不再追加 `result.response`，避免历史汇总文本污染新回复。旧回合的真实错误保留。取消、权限拒绝和普通成功结果仍按原来的路径处理。

这依赖 agy 的原生持久化格式，使用现有会话数据库路径约定及 `USER_INPUT=14`、`PLANNER_RESPONSE=15`、`ERROR_MESSAGE=17`、`DONE=3`，以及 Generator / Executor protobuf 的顶层错误字段 `5` / `12`。数据库缺失、不可读、元数据无法解析、只有部分输出、当前新增错误或身份无法确认时，Adapter 保留 CLI 的失败结果。原生格式升级仍需要核验这些字段。核验不修改原生数据库或 Renderer DOM，也不自动修写已保存的历史回合。
