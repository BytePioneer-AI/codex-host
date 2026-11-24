# 额度刷新自动继续与多 Harness 额度协同

`codexhost` 在 Host 层提供显式开启的**周限额 / 5 小时限额刷新后自动继续（Quota-Reset Auto-Continuation）**及**跨 Harness 只读额度协同**能力。它复用现有的公开 `AccountCreditsSnapshot`、官方 Codex `account/rateLimits/read`、外部 Adapter `inspectAccount()` 以及公开的 `thread read` / `thread send` 链路，不依赖具体 Harness 私有协议，也不自建凭据库或自动消耗重置卡。

## 核心规则

### 1. 多窗口与作用域判定（`packages/shared-contracts/src/quota-coordination.ts`）

- 账号级（无 `scope`）窗口与等于 `harnessId` 的 Harness 级窗口（如 Kimi Code 的 `kimi-code` 5h 窗口）始终适用。
- 模型/产品分组窗口（如 Antigravity 的 `Gemini Models` / `Claude and GPT Models`，Claude Code 的 `Opus · 7-day` / `Sonnet · 7-day`）仅在匹配显式 `scopeId` 或主窗口自身作用域时适用，避免一个模型组耗尽误阻塞其他独立模型组。
- 当多个适用窗口同时达到耗尽或低于 `minHeadroomPercent` 预留门槛时，有效最早解除时间为全部阻塞窗口的 **`MAX(resetsAt)`**——确保 5 小时窗口刷新时不会在周限额（`seven_day` / `weekly`）仍为 100% 的情况下盲目续跑。
- 预付费余额（`AccountBalanceSnapshot`，如 DSH / Pi API Key）标记为 `prepaidOnly`，没有重置周期，不支持按重置自动续跑。

### 2. 刷新确认与单飞合并（`packages/host-runtime/src/quota-continuation.ts`）

- 严格遵守 `docs/product/codex-accounts.md` 边界：到点不假定额度已恢复为 100%。
- 到达 `targetResetAt + resetGraceMs`（默认 15 秒）后，按 Harness 执行 **single-flight 合并实时刷新**（共享冷却窗口，避免同 Harness 下多个等待 Thread 反复冷启动探测子进程）。
- 若刷新确认所有适用窗口已恢复且满足 `minHeadroomPercent`，进入 `readyToResume`；若上游尚未滚动则按有界指数退避（默认 30s 起、上限 5 分钟）复核；若刷新发现更长周期窗口成为新阻塞项，则顺延目标时间或超出 `maxWaitMs` 时标记为 `expired` 并附带最新可用备选 Harness 列表。

### 3. 多 Harness 额度协同

- **跨 Harness 只读额度视图**：`codexhost harness quota [harness]`、HTTP `POST /v1/harness/quota` 与 MCP `harness_quota` 聚合官方 Codex 与已安装外部 Harness 的只读额度快照及按余量排序的 `availableAlternatives`（传入单个 `harness` 时仅探测该 Harness，不冷启动其他 CLI）。
- **Quota Pool 串行防惊群**：每个续跑任务归属一个 `poolKey`（默认 `<harnessId>:<scopeId|*>`；可通过 `--pool` / `poolKey` 显式关联共享同一上游 Billing Source 的多个 Harness，例如 Codex 与导入同一账号的 Pi 入口，不按跨 Provider 邮箱盲目合并）。同一池内按 `priority` 降序 + FIFO 放行，默认 `maxConcurrentPerPool = 1`；前一条续跑结束后复核池内余量，若低于 `minHeadroomPercent` 则将剩余任务退回等待下一窗口。
- **与 `thread watch` 投递协同**：当某个被通知的父 Thread 处于限额等待态时，`DelegationWatchService` 暂缓向其投递子任务完成通知并顺延投递窗口，待父 Thread 解除等待后再合并唤醒，避免在 0 额度时强行 `send()` 导致通知丢失。

### 4. 入口

| CLI | HTTP | MCP | 权限 |
| --- | --- | --- | --- |
| `codexhost harness quota [harness] [--scope <id>] [--refresh true\|false]` | `POST /v1/harness/quota` | `harness_quota` | `read` |
| `codexhost thread continuations` | `POST /v1/thread/continuations` | `thread_continuations` | `read` |
| `codexhost thread continue-on-reset <thread> [...]` | `POST /v1/thread/continue-on-reset` | `thread_continue_on_reset` | `dispatch` |
| `codexhost thread continue-cancel <thread>` | `POST /v1/thread/continue-cancel` | `thread_continue_cancel` | `dispatch` |

## 持久化、空闲释放与安全边界

- 续跑记录持久化保存在 `<数据目录>/quota-continuations/`（`packages/host-runtime/src/quota-continuation-store.ts`），沿用与 `delegation-watches/` 一致的原子写入与多 Runtime 进程 PID / boot-time 认领机制；定时器以绝对时间判定，兼容 Host 重启与主机休眠唤醒。
- 兼容外部会话默认 10 分钟空闲释放：等待期间不强占 Native Session 进程，唤醒时通过公开 `send` 自动恢复会话。
- **严格 Opt-in 与用户优先**：默认不自动续跑；若等待期间收到用户/外部 `thread send`、检测到更新的 Turn、执行 `thread cancel` 或存在未回答的 `pendingQuestions`，自动取消挂起的续跑任务。
- **结果未知不重发**：发送前写入 `dispatching: true`；若在发送结果未确认时遭遇异常或进程重启，保守记为 `failed` 要求人工确认，避免重复触发副作用。
- **绝不自动消耗 Codex 重置卡**（`hasResetCredits` 仅为只读提示）。
