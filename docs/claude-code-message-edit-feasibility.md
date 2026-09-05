# Claude Code 消息编辑实现与验证

2026-09-06：Claude Code 接入 `rollbackLastTurn` 和 `replacementFence`，沿用 Desktop 的公共编辑请求。

## 原生能力与映射

Claude Code TUI 支持 `/rewind` 后编辑重发。此前 Adapter 未完成适配，不能据此判断原生不支持。

| 情况 | Adapter 行为 |
| --- | --- |
| 回退多轮会话的最后一轮 | SDK `forkSession` 在上一轮的原生结束边界派生（assistant UUID 或中断标记 UUID）；没有结束边界时使用保留轮的 user UUID |
| 回退仅有的一轮 | 持久化空的待重发状态及新 UUID，不写入伪造的原生 transcript，也不发送占位 prompt |
| 待重发状态冷恢复 | 只读恢复 locator 和配置；在首次重发时以原生 `sessionId` 创建会话 |
| 首次重发完成后冷恢复 | 同一个 UUID 走普通原生 `resume`；历史不存在时报错 |
| 编辑更早的消息 | Host 按现有 `thread/revert` 语义逐轮回退，保留边界之前的完整历史 |

派生前后校验源历史不变、派生身份独立、完整语义前缀相同（用户输入、Items、结果、Model、checkpoint 是否存在），失败不提交 Host 映射。工具已修改的文件不随消息编辑回滚。

真实 CLI 的 result 事件可能早于 transcript 批量落盘。Adapter 记住最近完成的原生消息 UUID，读取或回退前等待它落盘；超时返回可重试错误，不能按暂时缺少一轮的历史继续回退。

## 首轮持久化与恢复

待重发状态保存在 `${CLAUDE_CONFIG_DIR:-~/.claude}/codexhost/pending-sessions/<UUID>/`。Mapping Store 保存的 Native Ref 带 `{ pendingSession: 1 }` locator；该内容由 Adapter 校验，Host 不解析 Claude 专用格式。`session.json` 带版本、UUID、绝对 cwd 和 Model / Thinking / Permission Mode 配置；目录和文件使用私有权限。

- 创建采用独占文件写入和同步，配置更新采用临时文件加 rename；Unix 同步父目录。
- 首次启动前独占创建 `started` 文件，阻止两个 Wrapper 同时以相同 UUID 创建原生 Session。
- 没有提交任何原生输入且已确认 Transport 关闭的启动失败，可以释放 claim，允许重试。
- 一旦提交输入，claim 不再释放。原生文件丢失、描述文件损坏或 cwd 不符不会被当作新空会话。
- 若进程在领取 claim 后、原生历史落盘前异常退出，恢复会保守报错，不自动重放无法确认是否执行的输入。原始源会话仍保留。

Native Ref 本身和 locator 均随 Mapping Store 持久化。配置在待重发状态下的修改也会落盘，不依赖旧 Host 进程内存。

## 手动暂停后的编辑修复（2026-09-06）

官方 Claude Code 2.1.196 复现过：暂停后追加 `[Request interrupted by user]` 用户角色记录，旧 Reader 将它误算为新的一轮，使 `thread/revert` 报“没有恰好删除一轮”。这不是 Harness 缺少编辑能力。

Reader 现在只在记录复用当前真实输入的 `promptId`、没有 `promptSource`、且内容是原生单文本中断标记时将它归入原轮；也识别工具执行期间的中断标记。用户自己发送相同字面文本（独立 promptId 或显式 promptSource）仍作为真实消息保留。中断标记作为该轮的取消证据与派生边界，使编辑后面的消息时仍保留前一轮的中断状态。

冷恢复还需在 Claude 原生 Session 尚未初始化时恢复 Mapping Store 保存的 Model / Thinking 选择，再恢复 Permission Mode，避免默认值替代此前配置。待重发 Native Ref 自带的持久化配置继续优先。旧 Reader 已经持久化的额外中断轮，通过现有的历史映射对齐流程在重开时移除，真实 Host Turn 身份保留。

回归覆盖：第一轮和第二轮生成中暂停后编辑、工具执行中暂停后编辑、已有暂停轮之后的编辑、尚未输出时暂停、暂停后重启再编辑、旧错误映射恢复、真实字面文本保留；测试沿用实际 Host、SDK 和 native CLI，并覆盖 Desktop 编辑函数生成的重发请求。

暂停修复的 154 项定向回归、7 个官方 CLI 场景通过；类型检查、ESLint、格式及包边界检查通过。

## 停止保证

`Session.close()` 传播启动、配置、Transport 停止及输出排空的失败。Host 只有确认旧 Session 关闭后才提交历史替换；失败保持未提交。故障 Session 继续由 Adapter 持有，直到显式关闭完成。

Transport 记录原生后台任务，先请求 `stopTask` 并等待原生终态，不能仅凭停止收据通过检查。Unix 为 SDK 进程及包装器创建独立进程组；即使包装器已退出，也清理组内后代，等待组消失，必要时升级到 SIGKILL。macOS 的存在性检查若暂时返回 EPERM，仍视为存活并继续等待，只有 ESRCH 证明组已消失；真正的发送信号失败继续阻止编辑。

Windows 在结束 SDK Query 前通过 `taskkill /T /F` 停止进程树；若根进程已经退出而无法确认后代状态，则关闭失败。本次没有 Windows / Linux 实机验证。

## 已执行验证

锁定 SDK 0.3.220；官方 Claude Code 2.1.196；macOS ARM64。

- Adapter / Transport / Host 调整定向测试 230 项通过，覆盖精确前缀、无 assistant checkpoint、延迟落盘、首轮配置持久化、并发 claim、启动重试、缺失历史、关闭失败、缺少后台终态、输出无法排空和包装器退出后的子进程清理。
- 真实官方 CLI + 本地 Anthropic 协议服务：连续编辑，模型上下文不含被替换输入；首轮回退后重启 Host 和 Mapping Store，再发送；再次重启后继续；源历史保留；已启动历史丢失时拒绝恢复为空。
- 在隔离环境执行了当前安装 Desktop 的编辑函数，检查它产生的重发输入，并连接实际 Host / Adapter / 原生 CLI。
- 真实官方 CLI 后台 Bash：开始标记已落盘后关闭 Transport，超过命令延迟时间仍没有后续写入。

完整 Desktop 点击体验仍需用户试用；隔离执行编辑函数不能代替界面验收。

## 当前官方集成基线验证

2026-09-06 合并上游插件化基线 `b71507e` 后，完整检查通过：TypeScript 2,644 项通过、17 项条件跳过；Rust 165 项通过。真实官方 CLI + 本地模型的 7 项编辑/暂停/重启场景及 1 项后台进程关闭场景再次通过，编辑场景执行当前 Desktop 编辑函数。Windows/Linux 的真实 CLI 交互仍未实机验证。

## 复现

```sh
npm run build:typescript
CODEXHOST_CLAUDE_REAL_COMMAND="$(command -v claude)" npx vitest run --config tests/vitest.config.js tools/gate-claude-code/rollback.real.test.mjs tools/gate-claude-code/close.real.test.mjs
```

使用已登录的原生 CLI 及真实模型时可设置 `CODEXHOST_CLAUDE_REAL_LIVE=1`；默认测试使用隔离配置和本地模拟模型。

可选 `CODEXHOST_CLAUDE_REAL_DESKTOP_ASSET` 指向本机提取的 Desktop app 资源，以验证实际编辑函数。测试按当前资源中的函数签名提取，签名变化会失败，不静默跳过。

2026-09-05 的原生可行性实验保留在 `tools/gate-claude-code/history-edit-probe.mjs`。实验还确认：无输入初始化、`/clear` 和仅有标题元数据的 transcript 不能提供所需的可恢复空会话，因此产品采用 Adapter 的持久化待创建状态。

参考：[Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)、[Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)。`resumeSessionAt` 包含指定消息，不能将其当作删除指定消息的接口。
