# 跨 Harness 委派：复用普通可写 Thread

当新 Harness 需要接收任务、在内部继续向其他 Harness 委派，或声称完整 Agent 协调能力时读取本页。原生 Subagent 的输出/Transcript 是另一项能力，见[输出与交互](output-and-interactions.md)。

## 公共路径，不新增专用执行接口

权威入口位于 `packages/host-runtime/src/`：

- `harness-delegation-coordinator.ts`：Adapter Map、配置校验、任务与普通 Thread 协调。
- `delegation-cli.ts`、`delegation-types.ts`：当前 CLI 和请求契约。
- `delegation-snapshot.ts`：进度与结果的只读投影。
- `external-thread-runtime.ts`：普通 Session 的创建、持久化和恢复。

```text
通用 inspect / delegate start / thread send、cancel、read、wait、list
  → Coordinator / Thread Runtime
  → HarnessAdapter.inspect / open
  → HarnessSession.execute / outputs / readSnapshot
```

插件通过 Manifest、工厂和 Loader 进入同一 Adapter Map，Coordinator 按实际 Map 校验身份。无需新增 adapter.delegate、专用 send/cancel、Catalog、CLI 路由或静态 Harness 名单。官方 Codex 的特殊路径不是外部插件模板。

## 接收任务与配置

通过公共接口验证：

- `codexhost harness inspect <id>` 调用真实 inspect，返回当前 Catalog/能力且不创建用户 Session。
- 调用方省略 Model/Thinking 时，open(create) 仍省略对应字段，让原生决定默认配置；不从 Renderer 最近偏好、其他 Thread 或静态表代填。
- 显式配置使用 inspect 返回的 opaque Ref/ID；Host 可前置校验，但原生 open 是最终确认点。
- 仅指定 Thinking 时，Host 可以用默认 Model 校验组合，这不授权把默认 Model 写成调用方显式 requested 值。
- create 正确处理 `unattended-full-access` 执行意图，规则见[公共行为](public-adapter-contract.md)，不为无人值守自动回答任意交互。
- 首次和后续 Turn 使用 Host 提供的 turnId，标准事件发布可见文本与真实终态。

需要对外观察的进度和最终回答使用 agentMessage；Reasoning、工具输出、命令与文件变化保留各自类型。观察结果来自公共投影，不让 Coordinator 读取新 Harness 的私有 Transcript。

## 普通 Thread 的持续可写语义

完整委派不是一次性执行脚本：

- 首次成功、可恢复失败或取消后，空闲 Session 能接收下一次 turn.start。
- 忙碌时第二次 start 返回 sessionBusy，不排队、不并发、不取消旧任务。
- cancel 只取消匹配的当前 Turn，不删除原生 Session 或清空历史；之后可以继续。
- readSnapshot 是只读操作，返回稳定多轮历史，不启动 Turn、不重放事件。
- Host 是 outputs 的唯一消费者；read/wait/list 使用 Host 投影，插件不另开消费者读取同一流。
- Host 重启后 resume 相同 Native identity 和历史，仍可 send/cancel。

缺少可写 resume 的原生系统只能明确交付受限后端；当前不会自动转换成 ephemeral 委派 Thread。Fork/Rollback 是另外的能力，不因支持委派就必须伪造实现。

## 继续向下委派：Session 环境必须到达执行现场

Host 提供：

- `CODEXHOST_CLI_PATH`
- `CODEXHOST_RUNTIME_ENDPOINT`
- `CODEXHOST_RUNTIME_TOKEN`
- `CODEXHOST_THREAD_ID`

所有受支持的 open 路径都将 `OpenSessionInput.environment` 原样传播到真正执行工具的进程/环境，不止在工厂保存一份基础环境。Thread 覆盖值不能被工厂旧值覆盖；共享服务必须验证能为不同 Session 区分它们。

- CLI_PATH 指定应使用的 CLI；不回退到 PATH 的另一份 codexhost。
- THREAD_ID 用于父子关系，endpoint/token 用于当前私有 Runtime；不自行生成、改名或猜测替代值，也不把它们写入日志。
- 验证安装的委派说明/工具对目标原生 Agent 实际可见。只传播环境不证明 Agent 已能发现和调用 CLI；现有 `.claude` 等周边安装规则不是所有 Harness 的通用保证。
- 原生沙箱无法访问 Runtime 时明确失败，不切换到其他 Host，不通过隐藏 Turn 绕过。
- 插件只传递执行能力，不自行发起隐藏委派或把子结果自动注回父 Turn。

## 人工交互

原生支持的 Approval/Question 仍通过公共 Interaction 实现，不因委派使用无人值守意图就删掉。

当前 CLI 帮助没有通用 thread respond 路径；可通过返回的 deepLink 在 Desktop 人工处理，前提是该 Harness 的 Desktop 产品接入已完成。后端-only 插件不能承诺用户一定能在现有 Picker/Thread UI 处理它。

交互挂起时验证 Thread 可观察、可取消，人工响应后可继续。不能用普通 Agent Message 替代待回复交互，也不能伪造答案来完成测试。

## 验收矩阵

| 场景 | 证据 |
|---|---|
| inspection | 正确 cwd/refresh、Catalog 与能力；无用户 Session |
| 默认/显式配置 | 省略保持省略；显式 opaque ID 经原生确认；非法组合拒绝 |
| 首次任务 | 执行策略与环境到位；稳定身份、可见进度和最终结果 |
| 后续任务 | 同一可写 Thread 接收第二个 Turn，忙碌时拒绝 |
| 取消与恢复执行 | 取消唯一终态，历史/身份保留，可再次 send |
| 只读观察 | read/wait/list 不触发新任务、不消费插件 outputs |
| 持久化 | Host 重启后 resume 同一会话并继续执行 |
| Interaction | 支持时可挂起、响应、取消和关闭；说明人工入口限制 |
| 递归委派 | 原生 Agent 用注入 CLI/Runtime 信息向另一个 Harness 发起任务；父子归属正确 |
| 错误 | 不可用 Harness、配置失败、原生退出均有类型化错误与正确终态 |

优先在插件公共接口测试中覆盖本地行为，增加实际 Coordinator 的聚焦集成；测试原生环境传播时同时观察子进程/服务真正收到的值。不要为新 Harness 复制整套 Coordinator。

分别报告“可接收委派”“可递归委派”“重启后可继续”“需要人工接管”的证据。只有范围内上述普通 Thread、环境和观察语义都验证，才称完整 Agent 协调支持。
