# 跨 Harness 委派：复用普通可写 Thread

对应能力总表：B15–B16。新 Harness 需要接收任务、在内部继续向其他 Harness 委派，或声称具备完整的 Agent 协调能力时，读本页。原生 Subagent 的输出和 Transcript 是另一项能力，见[输出与交互](spec-output-interactions.md#autonomous-turn-与原生-subagent)。

## 公共路径，不新增专用执行接口

权威入口位于 `packages/host-runtime/src/`：

- `harness-delegation-coordinator.ts`：Adapter Map、配置校验、任务与普通 Thread 的协调。
- `delegation-cli.ts`、`delegation-types.ts`：当前的 CLI 和请求契约。
- `delegation-cli-help.ts`、`delegation-cli-output.ts`：按命令组织的帮助和精简输出。
- `delegation-snapshot.ts`：进度与结果的只读投影。
- `delegation-skill.ts`：Host 托管的 `codexhost-delegation` Skill。
- `external-thread-runtime.ts`：普通 Session 的创建、持久化和恢复。

```text
通用的 inspect / delegate start / thread send、cancel、read、wait、list
  → Coordinator / Thread Runtime
  → HarnessAdapter.inspect / open
  → HarnessSession.execute / outputs / readSnapshot
```

插件通过 Manifest、工厂和 Loader 进入同一个 Adapter Map，Coordinator 按实际的 Map 校验身份。**不需要**新增 `adapter.delegate`、专用的 send/cancel、Catalog、CLI 路由或静态 Harness 名单。

## 接收任务与配置

通过公共接口验证：

- `codexhost harness inspect <id>` 调用真实的 inspect，返回当前的 Catalog 和能力，且不创建用户 Session。
- 调用方省略 Model/Thinking 时，`open(create)` 也省略这些字段，由原生决定默认配置。
- 显式配置使用 inspect 返回的 opaque Ref/ID；Host 可以预先校验，但原生 open 才是最终的确认点。
- 只指定了 Thinking 时，Host 可以用默认 Model 校验组合，但这不代表可以把默认 Model 当作调用方显式请求的值写入。
- create 要正确处理 `unattended-full-access`，规则见[会话核心](spec-session-core.md#执行意图与权限)；不能为了无人值守就自动回答任意交互。
- 首个和后续 Turn 都使用 Host 提供的 turnId，通过标准事件发布可见文本和真实终态。

对外可观察的进度和最终回答使用 `agentMessage`（能区分时设置 `phase`）；Reasoning、工具输出、命令和文件变化保留各自的类型。

## 普通 Thread 的持续可写语义

完整委派不是一次性执行脚本：

- 首次成功、可恢复的失败或取消之后，空闲的 Session 能接收下一次 `turn.start`。
- 忙碌时第二次 start 返回 `sessionBusy`，不排队、不并发、不取消旧任务。
- cancel 只取消匹配的当前 Turn，不删除原生 Session，也不清空历史；之后可以继续。
- `readSnapshot` 是只读的，返回稳定的多轮历史。
- Host 是 outputs 的唯一消费者；插件不另开一个消费者读取同一个流。
- Host 重启后，resume 到同一个原生身份和历史，仍然可以 send/cancel。

缺少可写 resume 的原生系统只能交付受限后端。

## 继续向下委派

### 环境必须到达执行现场

Host 提供以下环境变量：`CODEXHOST_CLI_PATH`、`CODEXHOST_RUNTIME_ENDPOINT`、`CODEXHOST_RUNTIME_TOKEN`、`CODEXHOST_THREAD_ID`。

- 所有受支持的 open 路径都要把 `OpenSessionInput.environment` 原样传播到**真正执行工具**的进程或环境中。共享服务（Gateway、常驻进程）必须验证不同的 Session 能各自区分这些值。
- `CLI_PATH` 指定要使用的 CLI，不能回退到 PATH 中另一份 codexhost。
- 不自行生成、改名或猜测这些值，也不把它们写进日志或提示词。
- 原生沙箱无法访问 Runtime 时明确失败，不切换到其他 Host。
- 插件只负责传递执行能力，不自行发起隐藏的委派，也不把子任务结果自动注回父 Turn。

### 让原生 Agent 发现 CLI（必须选定一种并实测）

只传播环境变量，不能证明 Agent 已经能发现并调用 CLI。现有三种做法：

| 做法 | 适用条件 | 参考 |
|---|---|---|
| Host 托管的 Skill | 原生会读取 `~/.agents/skills` 或 `~/.claude/skills`（`installDelegationSkills` 只安装到这两处） | Claude Code、Cursor |
| 原生的附加系统提示 | 原生支持类似 `--append-system-prompt` 的参数；提示中只写变量**名**，不写值；ephemeral 或环境不完整时不追加 | CodeBuddy、WorkBuddy `delegation.ts` |
| 进程内的临时私有 Skill | 原生支持在运行时注册 Skill；不往共享的技能目录写临时文件 | Hermes `gateway-delegation.ts` |

三种都不适用时，在 `CAPABILITIES.md` 中把 B16 标为「不支持」，不要去写用户的全局配置文件。

## 人工交互

原生支持的 Approval/Question 仍然通过公共 Interaction 实现，不能因为委派使用了无人值守意图就删除。当前 CLI 没有通用的 thread respond 路径，需要通过返回的 deepLink 在 Desktop 中人工处理。

## 验收矩阵

| 场景 | 证据 |
|---|---|
| inspection | cwd 和 refresh 正确，Catalog 与能力正确，没有创建用户 Session |
| 默认 / 显式配置 | 省略时保持省略；显式的 opaque ID 经原生确认；非法组合被拒绝 |
| 首个任务 | 执行策略和环境到位；身份稳定；有可见进度和最终结果 |
| 后续任务 | 同一个可写 Thread 接收第二个 Turn；忙碌时拒绝 |
| 取消与恢复执行 | 取消只有唯一终态；历史和身份保留；可以再次 send |
| 只读观察 | read/wait/list 不触发新任务，不消费插件的 outputs |
| 持久化 | Host 重启后 resume 到同一会话并继续执行 |
| Interaction | 支持时可以挂起、响应、取消和关闭；说明人工处理入口的限制 |
| 递归委派 | 原生 Agent 用注入的 CLI 和 Runtime 信息向另一个 Harness 发起任务；父子归属正确；所选的发现方式已实测 |
| 错误 | Harness 不可用、配置失败、原生进程退出都有类型化错误和正确终态 |

分别报告「可接收委派」「可递归委派」「重启后可继续」「需要人工接管」的证据。
