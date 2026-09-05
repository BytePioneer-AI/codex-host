# 身份与历史

所有插件读取 identity、create、Turn 和快照要求；持久化产品接入还必须实现 resume。Fork 和 Rollback 按原生能力选择。权威接口为 `packages/harness-adapter/src/text-session.ts`，相关 Ref schema 在 `packages/shared-contracts/src/ids.ts`。

## 所有权与身份

| 身份/数据 | 所有者 | 用途 |
|---|---|---|
| Host Thread ID、Host Turn ID、映射事务 | Host | Desktop 身份、实时事件关联、持久化协调 |
| `NativeSessionRef` | 插件提供，Host 保存 | 重启后定位同一原生 Session |
| `NativeTurnRef` | 插件提供，Host 对齐 | 识别同一个原生逻辑 Turn，不代表可 Fork |
| `NativeCheckpointRef` | 支持 Fork 的插件提供 | 标识可精确派生的历史边界，不是文件快照 |
| 原生消息、分支、Transcript 格式 | 对应 Harness / 插件 | 原生事实源及其公共快照投影 |

Native Ref 使用当前 Harness ID、稳定原生 ID 和需要时的可持久化 locator；不存进程内句柄、凭据或临时随机假身份。插件不直接写 Host Mapping Store，也不重新实现 Host 的 Thread 锁、导入去重和替换事务。

## Create 与 Turn

- create 产生独立可写 Session，不继承其他 Session 历史。
- identity 已知时放入 initialState；原生延迟创建时，在确认后及时发 state 事件。身份可持久化前不声称可恢复。
- 普通 Turn 的实时事件始终使用 Host 输入的 turnId；成功终态提供可与历史对齐的 NativeTurnRef。
- 原生失败/取消没有落盘时，不伪造 NativeTurnRef；如已落盘，返回相应稳定身份与实际 outcome。
- 原生无直接 Turn ID 时，可以基于稳定的消息/Entry ID 或插件拥有的持久化记录对齐。参考 Pi/OMP 的历史边界或 Claude 的消息身份，不使用每次读取重新生成的随机 ID。

## 只读快照：所有插件必须处理

`readSnapshot()` 返回公共 `HostThreadSnapshot`：

- 按原生有效分支和历史顺序返回逻辑 Turn，不把所有分支拼成一段对话。
- Turn 包含稳定 NativeTurnRef、用户输入、公共 Item、真实 outcome；支持精确派生的边界提供 checkpoint。
- 同一历史重复读取时，Turn/Item 身份稳定。历史损坏、分页缺失或无法确定终态时明确报错或使用类型允许的 unknown，不能猜测成功。
- 可携带当次确认的 state；与初始状态和实时状态语义一致。
- 不发送 Prompt、不触发 Agent、不把旧历史重放到 outputs，也不另占 outputs 消费者。
- 活动操作期间不能安全读时可返回 sessionBusy；无法读取时返回明确错误，不以空历史冒充成功。

完整普通 Thread 需要可靠历史；仅能实时输出的实现必须报告产品限制，不能将缺失快照视为无影响。

## Resume：持久化普通 Thread 的基线

- 验证 nativeRef，恢复同一 Native Session，返回可继续写入的 Session。
- 处理 Host 提供的 knownTurnRefs，保持历史与已有 Host Turn 对齐；原生稳定身份本身已足够时无需额外重编码。
- 原生返回不同 identity 时失败，不创建空会话冒充恢复成功。
- 传播本次环境和适用 cwd，读取原生已确认配置；不要盲目重放过期 Model/Thinking/权限。
- 恢复失败保留源历史及 Host 持久化记录，允许之后重试。

当前能力 schema 没有独立 resume 开关，也没有自动 ephemeral Thread 路径。原生不支持 resume 时，分支返回 unsupported，并明确这只是受限后端；不能声称支持持久化产品或完整 Agent 协调。

## Fork：精确保留前缀并独立继续

仅在 history.fork 为 true 时支持；forkAcrossCwd 为 true 必须同时支持 fork。

- 校验 sourceRef 和 checkpoint 属于同一 Harness、同一源 Session，且位置有效。
- 保留到指定 Turn 边界的历史，创建不同 Native Session，不修改源历史。
- 派生快照与目标前缀一致，末轮不能多也不能少；派生 Session 可继续执行。
- 跨 cwd 需要验证原生 Session 确实绑定目标目录；只改变子进程 cwd 不构成验证。
- 失败关闭新资源；原生支持安全删除派生临时数据时回收它，不误删源数据。无法回收的持久化副作用必须报告，不以清理失败掩盖原始错误。

Fork 分叉会话上下文，不回滚文件、不自动创建 Worktree，也不切换 Harness。

## Rollback：去掉最后一个完整 Turn

`rollbackLastTurn` 返回移除最后一轮后仍可继续的 Session，由 Host 执行替换；不在 Host 事务成功前破坏调用方仍使用的源 Session。

- 源历史非空且无活动操作；结果恰好少一个逻辑 Turn，而非少一条消息。
- 保留当前已确认 Model、Thinking、Permission Mode；原生不能保证时拒绝支持。
- 返回有效身份与精确保留前缀；只有一轮时可得到空白但可继续的新 Session。
- 原生无直接操作时，只有通过 Fork/Clone 等能满足上述语义才可组合实现。
- 失败不留下半替换 Runtime 或错误映射；原生临时资源按 Fork 的规则清理。

这是会话历史操作，不是工作区文件或 Git 回滚。

## 导入：可选发现，不转移事务所有权

需要导入已有原生 Session 时，读取 `packages/shared-contracts/src/harness-session-import.ts` 和 Adapter 的 `sessionImport` 接口。候选身份必须能真实 resume；原生发现、版本和 locator 由插件拥有，Host 拥有映射创建、去重、并发与失败恢复。

当前 DeepSeek 的上层导入入口仍是专用路径。提供候选接口不代表新 Harness 已有通用导入 UI；不要复制新的 Harness 专用导入方法来绕过缺口。

## 验收

1. create 和成功 Turn 产生可持久化身份；重复快照身份、顺序稳定。
2. 普通产品在 Host 重启后 resume 同一历史，继续第二个 Turn，不重放旧事件。
3. 快照中的工具失败、Turn 取消、原生异常和不完整历史如实反映。
4. 支持 Fork 时验证中间/末尾边界、源隔离、非法 checkpoint，以及声明支持的跨 cwd。
5. 支持 Rollback 时验证多轮、单轮、空历史、配置保留和失败不破坏源。
6. 缺失 Session、不可读文件/分页错误、打开失败和关闭路径均有资源清理测试。

Host 集成参考 `packages/host-runtime/src/external-thread-runtime.ts`、`external-thread-fork.ts`、`external-thread-rollback.ts`。当前恢复流程仍有 Grok/OpenCode/OMP 特例；新 Harness 必须通过通用路径验证。如通用恢复策略无法表达其原生配置语义，记录公共缺口，不扩展名称判断。
