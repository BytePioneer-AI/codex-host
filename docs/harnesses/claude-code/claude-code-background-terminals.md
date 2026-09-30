# Claude Code 后台命令与 Desktop 后台终端

Claude 在 `run_in_background` 下启动 Bash 时，原生结果立即返回并把命令交给原生后台任务管理。codexhost 不结束该命令 Item，而是让它脱离当前 Turn 继续运行，实时读取原生输出文件；原生任务结束时再补齐 Item 的最终状态。Desktop 据此把这些 Item 列入侧栏 "Background processes"，用户保留实时输出。

## 用户可见行为

- Claude 的后台 Bash 产生一张命令卡片；其所在 Turn 正常结束，卡片保持 `inProgress`。
- 运行中的输出尽力实时追加：原生只在给模型的结果文本里写出输出文件路径（"Output is being written to: …"），SDK 没有结构化字段或输出事件；取到路径就每秒读取新增内容，取不到就等结束时一次给出。
- 任务结束时，卡片在原 Turn 上补发完成：成功、失败或已停止。最终输出读取原生 `task_notification` 结构化给出的输出文件，按适配器的工具输出上限截断；文件读不到时，卡片以 `Native output is unavailable.` 完成。
- 输出文件尚未创建时继续轮询；其他打开或读取错误每个后台命令最多向 Host stderr 记录一次，诊断沿用公共脱敏规则，后续仍会重试。仅成功读取过的空文件才视为没有输出。

## 结算

- 原生 `task_notification` 是后台任务唯一的终止信号（`stopTask` 之后也以 status 为 stopped 的通知收尾）。它由后台 Agent 与后台命令共用，且不带任务类型。现有的 `native-message.ts` 统一把它解析为带 `callId`（`tool_use_id`）的 `subagent.settled`，本功能只补上结构化的输出文件路径。
- Session 在接收这一事件的唯一入口按 `callId` 分流：属于已登记的后台命令就完成该卡片，否则交给原有的 Subagent 处理。Subagent 逻辑不变。
- 收到通知后，后台命令保留到最终输出读取结束，但不再属于可停止的运行任务；期间重复通知不会改变首次结果。Session 关闭或故障时同步完成卡片：已收到通知的保留原生结果，其余取消。尚未完成的文件读取随后关闭句柄，不再追加输出或重复完成卡片。
- 顺序：Transport 在自主 Turn 中缓存事件，若批次中还欠着同一 `callId` 的工具事件，结算就留在批次中（`canDeliverSettlementImmediately` 对 Subagent 创建事件已采用同一规则）。因此卡片登记总是先于它的结算。
- 空闲释放与后台命令卡片无关：`hasBackgroundWork()` 直接反映 CLI 的原生活跃任务集合，任何原生后台任务都会阻止回收，因为关闭会话会停止它们。
- Desktop 的"停止全部后台终端"（`thread/backgroundTerminals/clean`）并行停止各卡片对应的原生任务，等待全部请求结束后汇总失败任务及原因；每个停止请求与中断共用同一超时，超时作为停止失败返回（-32083）。

## 各模块所有权

- `native-message.ts`：原生边界。从 Bash 结果解析 `backgroundTaskId` 与实时输出路径，从 `task_notification` 解析结构化输出路径。
- `tool-lifecycle.ts`：Bash 结果带 `backgroundTaskId` 时不结束卡片，改发 `item.detached` 并交给后台命令卡片。
- `background-command-items.ts`：以 `callId` 跟踪卡片，推送输出增量，按通知完成卡片；会话关闭或故障时保留已知结果，仅取消尚未收到原生结果的卡片。
- `sdk-transport.ts`：原生活跃任务集合（空闲释放）、有超时的 `stopTask`、上述顺序规则。
- `item-identity.ts` + `claude-history.ts`：工具 Item 的实时 ID 与历史 ID 同为 `claudeTranscriptItemId(nativeTurnKey, "tool", ordinal)`。
- `protocol-core` 投影层：detached Item 可越过 `turn/completed`，之后仍在原 Turn 上更新与完成。
- `host-runtime`：在 detached Item 结束前保留 Turn 投影；历史读取时按 Item ID 替换或追加仍在运行的卡片；处理 `clean`（未加载返回空成功；Harness 不支持返回 -32076；停止失败返回 -32083）。

## 限制

- Desktop 只提供"全部停止"，没有单个后台终端的停止入口；`thread/backgroundTerminals/clean` 属于 Desktop 的 experimental 协议。
- 实时输出依赖结果文本中的路径措辞；措辞变化时只失去实时输出，最终输出与结果不受影响。
- 退出码不解析，`exitCode` 保持 null。
- Host 重启后不恢复运行状态：重新读取的历史里该卡片显示为原生记录的启动结果。
- 经 Broker 的远程主机未转发 `hasBackgroundWork` 与 `stopBackgroundWork`。

## 验证

```sh
npx vitest run --config tests/vitest.config.js \
  packages/adapters/claude-code/test/sdk-transport.test.ts \
  packages/adapters/claude-code/test/background-command-items.test.ts \
  packages/adapters/claude-code/test/native-message.test.ts \
  packages/adapters/claude-code/test/claude-history.test.ts \
  packages/adapters/claude-code/test/claude-code-adapter.test.ts \
  packages/protocol-core/test/codex-ui-projector-detached.test.ts \
  packages/host-runtime/test/app-server-host.background-terminals.test.ts
```
