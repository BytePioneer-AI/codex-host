# 外部 Thread 的「调整方向」

codexhost 将外部 Harness Thread 的「调整方向」定义为：**取消当前 Turn，等待它终结，再自动执行本次新输入**。用户继续使用 Codex Desktop 原有按钮、跟进处理方式设置和单条消息反向操作，不需要手动停止后重发。官方 Codex Thread 仍透传原生 `turn/steer`，不改变同轮追加输入的语义。

## 所有权与执行

- `AppServerHost` 显式按 Thread 所有权分流 `turn/steer`，外部 Thread 不再落入官方 Account 查找。
- `ExternalTurnSteering` 在取消前校验非空文本输入及 `expectedTurnId`，注册指定旧 Turn 的终态等待，再调用现有 `turn.cancel`。不会调用 Harness 私有接口或增加 `turn.steer` 公共命令。
- 取消 acknowledgement 不等于完成。等待旧 Turn 的 Interaction/Item 关闭、终态身份持久化及 Desktop 终态通知写出后，复用普通 `turn/start` 的底层启动函数，分配真实的新 Host Turn ID，返回 `{turnId}`。
- 同 Thread 的其他 start、Harness command、委派 start 不能抢占这个替换过程。若原生自主 Turn 已先开始，替换失败，不取消这个意外的新 Turn。
- 取消与旧轮终态等待合计最多 20 秒，短于当前 Desktop 的 30 秒提交超时。超时、Session fault、输出流结束、Host 关闭/断连、显式停止替换、旧轮失败或持久化失败均不再自动启动新轮。新轮启动本身仍遵循原有 Adapter admission 语义；客户端超时不意味着它没有被接受。
- 同一连接内以 `threadId + clientUserMessageId` 合并相同请求，并保留有界的成功交付回执供 outcome-unknown 重试使用；同一消息 ID 不得携带不同的旧轮 ID 或输入。不承诺跨 Host 重启或回执淘汰后的 exactly-once。

普通停止仍调用 Adapter 原来的取消实现。原生进程、工具和子任务的退出速度及恢复策略属于 Adapter；本功能没有增加统一的强杀策略，也不会回滚旧轮已经完成的文件修改。

## Renderer 接入

只在 Host 实现 cancel/start 不足以接入官方界面：官方 steer 会把乐观消息放在旧 Turn，旧轮 interrupted 时又可能将它恢复到暂停队列。

`renderer-external-steering.ts` 在已确认的 RequestManager 上包装 `steerTurn`。Desktop Manager 同时是 `RpcTarget`，跨组件 RPC 禁止访问实例自身属性（即使该属性是函数）。因此对原型方法的包装放在该实例专属的原型层上，不用 `manager.sendRequest = ...` 创建实例属性，也不修改共享类原型。卸载时移除覆盖并恢复原型查找，不能仅赋回原函数；否则模型和权限列表仍会被 RPC 拒绝。

接入流程：

1. 查询当前连接的 Thread 所有权；官方 Thread 走原函数，follower 窗口继续使用 Desktop 原有 owner 转发。
2. 外部输入使用 Desktop 自己的 `startTurn` 展示流程。新输入从一开始就属于新 Turn 占位，保留 `clientUserMessageId`、输入及附件展示上下文；不创建旧轮 `steeringUserMessage`，不修改官方 transcript 内部实体。
3. 仅将本次 `threadId + clientUserMessageId` 对应的出站 `turn/start` 转成 `turn/steer`，携带原先捕获的 `expectedTurnId`。把 Host 的 `{turnId}` 回执转换成正常 start 展示流程需要的 Turn envelope。其他 start、请求选项及官方 steer 不变。
4. 成功后解除本次旧轮 interrupted 引入的队列暂停，保留此前已暂停的消息。失败不自动重试或偷偷排队；Desktop 原有失败提交展示负责保留输入。
5. 绑定卸载时停止新的替换，恢复包装过的方法；尚未发出的替换不能因卸载而意外成为普通 start。

Host 和 Renderer 接入必须配套发布；仅升级 Host、让旧 Renderer 仍创建旧轮乐观 steer 消息，不属于经过接入的产品路径。

### 当前兼容边界

接入点依据 Codex Desktop **26.901.51231 / build 8109** 的 `app-initial-cadb12d4a15e.js`：`steerTurn`、`startTurn`、`sendRequest`、`getTurnCoordinator()` 的 submissionHost，以及队列的 `loadMessages` / `readMessages` / `mutate`。这些是版本相关的 Desktop JavaScript 绑定，不是 Harness SDK 契约。更新 Desktop 后需重新核实。

- 当前公共 Harness 输入仅支持文本。图片等非文本输入、空输入、tool response 在停止前拒绝，不静默丢弃后再取消旧轮。
- 新输入作为普通文本 `turn.start` 提交，不另行解释成 Harness command。原有独立 command 路径不变。
- 当前轮尚无确认的 Turn ID 时不猜测目标，也不把过期目标改为另一轮重试。
- 旧轮和新轮在 Native Session 历史中是两个真实 Turn，不复用旧 ID、不伪造同轮注入，不合并 Fork/Rollback 身份。

## 验证

针对性测试：

- `packages/host-runtime/test/external-turn-steering.test.ts`：延迟/同步终态、去重、冲突、过期目标、输入预检、超时迟到、fault、关闭、显式停止、自主 Turn 及启动失败。
- `packages/host-runtime/test/app-server-host.test.ts`：真实 Host 路由、外部不泄漏官方流、取消与启动顺序、响应 gate、同 Thread start 竞争、官方透传。
- `packages/renderer-extension/test/renderer-external-steering.test.ts`：正常 start 占位、唯一输入、无旧轮 steer Item、去重、队列暂停恢复、owner/follower、失败和卸载。
- `packages/renderer-extension/test/renderer-external-steering-rpc.test.ts`：类方法的 RPC 可访问性、模型／权限列表读取、官方与外部 steer、实例隔离、卸载和重复安装，以及卸载期间待定请求的清理。
- `packages/renderer-extension/test/versioned-renderer-adapter.test.ts`：现有版本化绑定与清理回归。

实现时还在 Node VM 中回放了上述 Desktop Bundle 的真实 `lun`（普通 start）、`GS`（占位写入）和 `Irn`（旧轮消息恢复）helper：legacy / canonical 历史各验证启动成功与启动失败，检查单条新输入、无旧轮 steer 恢复、失败输入保留。该回放仍模拟了准备器与传输，不是实际窗口或原生 Session 测试。

针对 RpcTarget 实例属性回归，还在运行中的上述版本 Desktop 内通过其真实 `RpcStub` 调用了 `model/list` 和 `permissionProfile/list`，验证原型挂接修复后两者成功返回，并重试了此前失败的只读查询。该检查没有发送新消息、修改权限选择或验证原生 Harness 执行。

以上合成测试和只读 RPC 检查不替代真实 Desktop 与各原生 Harness 验收。发布验收应覆盖流式文本、工具运行、Question/Approval、连续提交、已有队列、取消失败、刷新历史，以及多窗口和远端连接。不得把类型检查或合成测试通过称为所有 Harness 的实机兼容性证明。
