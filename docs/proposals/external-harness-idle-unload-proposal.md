# 外部 Harness 空闲会话自动释放方案与实现

> 状态：已按确认方案在独立分支实现，见 [PR #303](https://github.com/BytePioneer-AI/codex-host/pull/303)。尚未发布；真实 Desktop 与逐 Harness 实测仍待完成，PR 保持 Draft。
> 来源：[#294](https://github.com/BytePioneer-AI/codex-host/issues/294) 及后续方案讨论。
> 依据（2026-09-15）：源码核对；本机 Codex Desktop 26.908.40834 安装包与日志分析；stock `codex-cli 0.154.0-alpha.6.2` app-server 实测；Host 合成探针测试（临时文件，未提交）。未在真实 Desktop 上验证自动释放与恢复。
> 修订：前几版分别评估了 Renderer 前台上报、接入 Codex 原生退订语义、Adapter 活动探针与进程组检查，均因复杂度或收益问题未采用（见第 6 节）。本版改为用户显式开启、达到可配置空闲时间后关闭会话的简化方案，并保留可恢复性与 Host 操作协调保护。最近一次审查后明确：方案仅考虑本地 Host，远程 Host 不在范围内；进行中的 Host 操作以按 Thread 的占用计数保护，不以空闲时长兜底；设置校验共用 `shared-contracts` schema；设置页内部 ID 保持 `appearance`；超时时间为 10～1440 分钟整数；设置存储采用 Renderer localStorage 并下发给本地 Host。

## 1. 背景与目标

外部 Harness 的逻辑 Thread、已加载 Session 和进程数量不是同一个指标。当前 Host 中已启动的 Session 在 Turn 完成后通常继续驻留；多数 Harness 每个 Session 独占后端进程（第 5.1 节），长时间不用的会话会持续占用内存和进程。

目标：为用户提供一个可选的自动释放能力，关闭长时间空闲会话的后端进程，再次使用时自动恢复原 Native Session。不承诺固定资源节省量，也不承诺减少 Token 费用。

原 Issue 提议仅在下一条真实用户消息到来时恢复，并包含连接数量阈值、观察模式等要求。本方案是范围更小的替代，不应宣称完整实现了原 Issue。

范围：本方案的全部功能只针对本地 Host。受管远程 Host、远程控制连接等远程场景不在本方案范围内，不设计、不验证。

## 2. 方案概述

- 将现有设置中的“外观”页更名为“通用”，保留原有外观选项，新增“自动释放空闲会话资源”开关和空闲超时时间输入项。
- 开关**默认关闭**，超时时间**默认 30 分钟、允许在 10～1440 分钟内修改**。开启即生效，不弹确认框；影响说明放在标题旁的问号浮窗中，页面不出现大段文字。
- **仅考虑本地 Host**：设置只下发给本地 Host；远程 Host 不在范围内。
- 开启后，外部 Thread 空闲达到配置时长且满足 Host 保护条件时，Host 调用现有 `HarnessSession.close()` 关闭会话，并从内存移除该 Thread，不发送额外的卸载状态通知。
- 之后需要执行实例的请求（打开、发送消息、读取历史等）经现有 `ExternalThreadRuntime.resolve()` 自动恢复；仅元数据等请求保持现有不恢复行为。
- 不证明所有原生附属进程或后台任务均已结束，由用户在开启时知情接受可能中断这些资源；仍保护 Host 已知的进行中任务与操作。
- 面向所有 Harness，优先复用现有 Adapter 关闭和恢复接口，不新增统一安全探针。是否需要修正具体 Adapter，由逐个验证结果决定，不能预先承诺零修改。

## 3. 行为规则

### 3.1 设置

- 位置：现有“外观”页显示名称改为“通用”（英文 General），页面内部 ID 保持 `appearance`（`appearance-page.ts`），保留已有外观设置和偏好，新增“资源管理”分组。只修改本地化中的页面名称和页面描述（现描述为“调整会话中思考文本的显示方式”，需改为覆盖外观与资源管理），控件、说明和错误提示均走现有本地化机制。
- 作用范围：仅本地 Host。Renderer 只向本地 Host（`hostId` 为 `local`）发送该设置。远程 Host 不在范围内，本方案不为其增加任何处理。
- 布局：页面标题与一行描述下分为“外观”“资源管理”两个卡片分组；资源管理标题右侧仅在设置未生效时以带颜色圆点的短文本显示状态（同步中、当前 Host 不支持、同步失败），同步成功时不显示；“仅作用于本地 Host”的说明放在问号浮窗中。每行只有标题、一行描述和右侧控件。
- 控件：“自动释放空闲会话”开关（`role="switch"`），以及“空闲超时”数值输入框，单位“分钟”显示在输入框内，不使用下拉框。开关默认关闭，时间默认 30 分钟；关闭开关不丢失已保存的时长。
- 取值范围：**10～1440 分钟的整数**。输入框设置 `min=10`、`max=1440`、`step=1`，描述行注明范围；空值、小数、超出范围的输入禁止保存，输入框变为错误样式，描述行改为“请输入 10～1440 之间的整数。”。
  - 下限 10 分钟：空闲检查约每分钟一次，过短的时长误差占比大；避免用户阅读或思考时频繁释放、恢复；给 Turn 结束后迟到的后台输出留出余量。进行中操作的保护仍由占用计数负责，不依赖下限。
  - 上限 1440 分钟（24 小时）：更长的时长基本等于不释放，应直接关闭开关；同时消除毫秒换算溢出问题。
- 校验规则（含上下限）定义为 `shared-contracts` 中的单一 schema，Renderer 与 Host 共用，避免规则漂移。首次未设置时使用 30 分钟；无效持久化配置不启用自动释放。
- Host 只应用完整且有效的设置。用户修改时长后，下一次检查按新阈值判断，不重置已有活动时间；缩短时长可能使已闲置会话在下一次检查被释放，界面需明确说明。
- 关闭状态不发起新的检查或关闭；已经开始的关闭继续完成或明确失败，不能取消等待后直接恢复旧实例。
- 影响说明：开关标题旁的问号按钮在鼠标移入或键盘聚焦时显示浮窗（`role="tooltip"`，按 Esc 收起），以短句列出：
  - 即使正停留在该会话页面，也可能被释放。
  - 会话启动的服务（如开发服务器）和后台任务会一并停止，结果可能丢失。
  - 再次打开或发送消息时恢复原会话，需等待 Agent 重新启动。
  - 缩短超时后，已空闲的会话可能很快被释放。
  - 仅作用于本地 Host 上的外部 Agent 会话。
- 样式：设置页引入 Tailwind CSS（构建期依赖），由 `renderer-extension/scripts/tailwind-esbuild-plugin.mjs` 编译 `settings/tailwind.css` 并以文本注入设置页 Shadow DOM。只引入 theme 与 utilities、不引入 preflight；颜色映射到现有 `--settings-*` 变量以保持深浅色一致；插件显式声明 cascade layer 顺序，并把 `@property` 初始值展开为普通声明（Chromium 不在 Shadow DOM 中注册 `@property`）。现有 `shell.css` 的元素级基础样式移入 `@layer base`，其余组件样式保持不变。

- 存储方式：**Renderer localStorage + 下发给本地 Host**。
  - Renderer 将开关和时长保存在 localStorage 的 `codexhost.idle-release.v1` 键中（JSON 对象 `{ enabled, timeoutMinutes }`），沿用现有偏好模块的做法；读取失败或读到无效值时按默认值（关闭、30 分钟）处理。写入失败明确提示保存失败，不将未保存的输入作为已生效设置，也不覆盖之前的有效配置。
  - Renderer 在与本地 Host 建立连接后、以及设置变更时，通过 `codexhost/settings/idle-release/set` 把完整设置下发给本地 Host，成功响应返回应用的完整设置。多个窗口重复下发同一设置是幂等的，以最后一次为准。
  - 每次实际下发前重新读取 localStorage；监听 `storage` 事件同步其他窗口的变更，不在重连时重放窗口缓存。单个连接串行下发并合并等待中的变更；新连接不被旧连接未完成的请求阻塞，旧响应不能覆盖新连接的应用状态。
  - Host 只把设置保存在内存，不新增持久化文件。Host 重启或连接重建后，在 Renderer 重新下发前按“关闭”处理。
  - Host 用共用 schema 校验；无效的设置返回错误，不覆盖已有有效配置。
  - 旧版 Host 不支持该请求时，Renderer 现有请求发送器会得到“方法不支持”错误，设置页提示当前 Host 不支持此功能，不静默当作已生效。

### 3.2 空闲判定

同时满足以下条件的已加载外部 Thread 视为可释放：

1. 设置已开启；
2. 没有进行中的 Turn：`running` 为 false 且 `activeTurnId` 为空（审批、提问都发生在 Turn 内）；
3. 没有运行中的 Subagent（Host 现有 `#hasRunningSubagents()`）；
4. 没有待发送的 steering 消息；
5. 该 Thread 的 Host 操作占用计数为 0（见第 3.3 节），没有已知待处理审批或提问；
6. 持久化记录为 `ready`，存在 `nativeSessionRef`，且 `persistenceError` 为空；
7. 距离最后一次活动已达到配置时长（默认 30 分钟）。

“活动”指以下任一事件，发生时更新该 Thread 的最后活动时间：

- Thread 创建或恢复；
- 任何请求经 `resolve()` 访问该 Thread（包括读取、执行、配置、委派）；
- Host 处理该 Thread 的任一 Harness 输出；
- 针对该 Thread 的 Host 操作完成或失败（包括不经 `resolve()` 的生命周期操作），使空闲从操作结束时重新计时。

活动时间只用于选择候选，**不作为未完成操作的保护**：最近访问过不等于操作已结束，且超时时间允许调小。未完成操作由条件 5 的占用计数保护。

后台读取或周期性输出也会重置计时，因而可能延后或阻止释放；这是本简化方案接受的保守行为，不承诺所有闲置进程都在固定时间内退出。

排除项：Subagent 子 Thread（`ReadonlySnapshotSession`，不占原生进程）不参与释放。

条件 2 不能省略：`close()` 会取消进行中的 Turn，属于用户可见的任务中断，与“空闲释放”语义不符。

### 3.3 关闭流程

- Host 在设置开启期间运行一个低频检查（例如每分钟一次，`unref` 定时器），Host 退出或设置关闭时停止。
- 对满足条件的 Thread：
  1. 在同一受控入口内检查条件并标记该 Thread 正在关闭；此后需要执行实例的请求等待关闭结果。
  2. 调用 `session.close()`，再等待 `outputTask` 结束，清理关闭期间产生的待处理交互。关闭标记覆盖关闭、输出 drain、交互清理、持久化确认和最终移除全过程；关闭及 drain/交互清理合计最多等待 60 秒，超时按关闭失败处理。
  3. 再次确认恢复身份可用、没有输出处理或持久化失败，并确认 Runtime 中仍是这次关闭的原实例。
  4. 成功后移除原实例并清除关闭标记，等待中的请求按现有逻辑合并恢复。
- 关闭失败、超时、输出消费失败或持久化失败：记录诊断，**保留原 Session 引用与 Host 侧明确的关闭失败标记**，不自动重试回收、不自动重建。关闭失败检查统一放在 `locate()`，所有经过 `locate()` / `resolve()` 的入口返回明确错误，不能依赖旧 Session 自行拒绝请求。等待关闭的请求也必须得到失败结果，不能无限等待。
- 超时不意味着底层关闭已停止；保留失败标记，不能因旧关闭任务稍后返回而移除新实例或自动解除失败状态。重启建议通过请求返回的错误消息展示，不另建通知机制；不保证所有异常情况下仅重启就能清除残留资源。

**操作协调**（不新建完整操作登记系统）：

- 复用现有 `DesktopRequestQueue`：回收操作通过 `run(threadId, …)` 与该 Thread 的 Desktop 请求串行执行。入队后执行时重新检查设置、活动时间和占用条件；仍有操作就跳过，不在队列内等待占用清零。
- Desktop 的 fork / rollback 等被 `await` 的路径已经在队列内；队列只等待传入操作返回，不能覆盖 `turn/start`、`turn/steer` 和命令执行另行派发的任务，以及委派控制 API、审批/提问响应。使用**按 Thread 的 Host 操作占用计数**覆盖这些路径及 Desktop 请求，并保护新 Thread 注册后的初始化操作：
  - 通过 `runOperation(threadId, operation)` 在取得 Session 引用之前同步加 1，再执行 `locate()` / `resolve()` 和操作；统一在 `finally` 减 1，避免“已取得 Session 引用但尚未计数”的空窗；
  - 只跟踪 Host 操作，不探测原生后台任务，也不把整个 Turn 纳入计数（Turn 由条件 2 覆盖）；
  - 计数减为 0 时刷新最后活动时间。
- 回收在同一同步段内确认计数为 0 并标记正在关闭；之后新的占用请求等待关闭结果。由于关闭只在无人持有执行实例时开始，已取得 Session 引用的异步操作不会与关闭交错；`locate()` 的失败检查只负责之后到达的请求。
- 回收与替换、删除、归档及 Host 退出使用同一协调规则。移除时以对象引用核对 Runtime 中仍是这次关闭的原实例，防止旧任务删除同 ID 的新实例。
- 不重新引入 Adapter 安全探针：关闭期间原生后台活动仍可能被中断，属于开启时告知的风险。该取舍不允许放弃 Host 已知操作的互斥、输出消费和持久化保护。

### 3.4 恢复

- 恢复复用现有冷态路径：`resolve()` → `#restore()` → `adapter.open({ kind: "resume" })`，与 Host 重启后打开历史 Thread 相同。
- 恢复会创建新的 Session 对象，不复用已关闭的对象。
- 现有恢复路径保证 Native Session 身份一致（`alignSnapshot()` 校验）；不保证 cwd、Model、Thinking 与释放前完全一致，例如 OMP、OpenCode 恢复时可能静默替换 Model 并持久化实际状态。这与 Host 重启后的恢复行为一致，本方案不额外承诺。
- 不通知 Desktop：Desktop 中该 Thread 保持原状态；用户下一次操作触发恢复，期间等待 Harness 启动。

## 4. 用户可见影响与风险

| 影响 | 说明 | 处理 |
| --- | --- | --- |
| 会话启动的服务被停止 | Pi、OMP、ACP 类等关闭时向进程组发信号；Claude Code 关闭时先 `stopTask` 停止所有后台任务 | 开启前提示 |
| 后台任务结果丢失 | Turn 结束后原生侧仍可能有后台工作，完成后以自主 Turn 回传（如 Claude Code “publishes an autonomous Root Turn after background task completion”）；关闭后不再回传 | 开启前提示 |
| 恢复等待 | 释放后首次打开或发送消息需要等待 Harness 启动 | 开启前提示 |
| 阅读中被释放 | 用户停留在某个 Thread 超过配置时长且无活动也会被释放；下一次需要执行实例的操作触发恢复 | 开启前提示 |
| 部分 Harness 收益有限 | Antigravity 空闲时不占进程；DeepSeek Harness 多个会话共用一个进程 | 逐 Adapter 验证资源释放范围，不能影响其他会话 |
| 关闭失败 | 保留原实例引用并由 Host 阻止继续使用和自动重建，明确提示恢复办法 | 记录诊断，不预设失败概率 |

## 5. 已核实的现状

### 5.1 各 Adapter 的关闭与恢复

所有 Adapter 都实现了 `HarnessSession.close()`（公共契约必选）和 `open({ kind: "resume" })`。

| Adapter | 空闲时进程 | `close()` 行为 |
| --- | --- | --- |
| Pi | 每会话一个 `pi --mode rpc` | 有活动 Turn 先 abort；关 stdin，超时依次 SIGTERM、SIGKILL 进程组 |
| OMP | 每会话一个 RPC 进程 | 同上 |
| Claude Code | 每会话一个 SDK 子进程 | 停止后台任务，结束进程组 |
| CodeBuddy | 每会话一个 ACP 进程 | 关 stdin，超时强杀进程树 |
| Cursor | 打开会话时启动 CLI 进程并驻留 | 关 stdin，超时 SIGKILL |
| Grok / Hermes / Kiro | 每会话一个 ACP 进程 | 关 stdin，超时 SIGTERM 或 SIGKILL |
| OpenCode | 每会话独占一个 server 进程 | 结束该 server 进程 |
| Antigravity | 无，每个 Turn 临时启动进程 | 结束进行中 Turn 的进程，flush 历史 |
| DeepSeek Harness | 同一 Adapter 下共用一个 `dsh web` 进程 | 不结束共用进程 |

### 5.2 Host 恢复入口

所有需要执行对象的入口都经过 `resolve()`。合成探针（Fake Adapter，冷态为“Store 有记录、Runtime 未加载”）确认以下请求会触发恢复：含 Turns 的 `thread/read`、`thread/turns/list`、`thread/items/list`、`thread/resume`、`codexhost/thread/inspect`、`codexhost/thread/usage/inspect`；不含 Turns 的 `thread/read`、`thread/name/set`、`codexhost/thread/commands/inspect`、`thread/unsubscribe` 不触发。源码核对 fork、rollback、`turn/start`、`turn/steer`、`turn/interrupt`、配置选择、命令执行和委派 CLI 也经过 `resolve()`。冷态 `thread/resume` 只恢复一次，并发恢复由 `#restores` 合并。

### 5.3 Host 数据模型

- `ExternalThread.session` 为必填；Thread 从 Runtime 移除后即为未加载，恢复无需新状态。
- `outputTask` 只在 Session 输出通道结束后才结束，因此只能在 `close()` 之后等待。当前输出消费路径会捕获部分异常，不能把该 Promise 完成视为持久化成功；释放逻辑还需检查 `persistenceError`，并显式获知其他输出消费失败。
- Mapping Store 保存元数据、Native Session 引用和 Turn 映射，不保存完整 Transcript；恢复从 Harness 原生历史读取。
- Host 目前没有通用的设置持久化机制；现有偏好保存在 Renderer localStorage，Host 运行配置来自环境变量。
- `DesktopRequestQueue.run(threadId, operation)` 按 Thread 串行 Desktop 请求，但只等待传入操作返回；`turn/start`、`turn/steer` 在处理函数中再次派发异步任务，委派控制 API 不经过该队列。
- 每个 `AppServerHost` 在构造时创建自己的 `ExternalThreadRuntime`；Renderer 通过 `clientForHost(hostId)` 访问 Host，本地 Host 的 ID 为 `local`。

## 6. 未采用的方案

| 方案 | 未采用原因 |
| --- | --- |
| Renderer 前台上报 + Host 计时 | 依赖 Composer DOM 属性和 React Fiber 回退等 Desktop 私有接线；多窗口共用一条连接且无窗口身份 |
| 接入 Codex 原生 `thread/unsubscribe` | Desktop 策略为不活跃 3 小时或超过 10 个才退订，codexhost 无法调整；需实现订阅语义、发送 `thread/closed` 并在真实 Desktop 验证外部 Thread 的表现，工作量明显更大 |
| Adapter 活动探针 | 除 Claude Code 的 `#backgroundTasks` 外，Pi、OMP、OpenCode、ACP 类、Cursor 的原生接口都不暴露后台进程或任务；需要逐 Adapter 实现 |
| 进程组存活检查 | 代码简单，但 MCP server、语言服务等常驻辅助进程会让会话永远判为忙；Windows 无进程组；需逐 Harness 实测基线 |

若后续证明自动释放误伤明显，可在本方案基础上为个别 Adapter 增加活动判断，而不需要推翻整体设计。

## 7. 修改位置与复杂度

| 功能 | 主要位置 | 复杂度 | 工作量 |
| --- | --- | --- | --- |
| 最后活动时间、空闲检查、关闭流程 | `host-runtime` 新模块，`ExternalThreadRuntime` 增加受控入口 | 低至中 | 2～3 天 |
| 操作协调：复用 `DesktopRequestQueue`，按 Thread 占用计数 | `ExternalThreadRuntime`、未入队的调用点（`turn/start`、`turn/steer`、委派、替换） | 中 | 含在上项 |
| 设置下发请求与共用 schema | `shared-contracts`、本地 Host 请求处理（内存保存） | 低 | 半天～1 天 |
| “外观”显示名改为“通用”、开关、时长输入及说明 | `renderer-extension` 设置页、本地化 | 低 | 约 1 天 |
| 所有 Adapter 的关闭恢复验证及必要修正 | 各 Adapter 测试；实现按验证结果决定 | 待验证 | 另计，不预先承诺零修改 |

**粗估**：Host 与设置部分约 1 周，Adapter 验证另计。该数字仅用于评估，未经验证，不构成交付周期承诺。检查逻辑放在独立模块，避免继续扩大 `app-server-host.ts`；Host 通过公共契约使用 Adapter，不导入具体插件；Renderer 不参与释放判断。

## 8. 测试与验证

单元与合成测试（Fake Adapter、Fake Timers）：

- 设置关闭或未收到设置时不发起回收；设置无效不启用，更新无效不覆盖已有有效配置。
- Renderer：设置写入并从 localStorage 回显；读取不可用或值无效时按默认值，写入失败明确提示；连接本地 Host 后及设置变更时下发；多窗口读取最新存储并同步；旧连接迟到响应不覆盖新状态；Host 不支持该请求时设置页给出提示。
- Host：重启或连接重建后在收到下发前不回收；重复下发同一设置不重置已有活动时间。
- “通用”页保留原外观选项，新增开关、时长输入和本地化说明；默认关闭、默认 30 分钟，已保存值正确回显。
- 覆盖 10～1440 整数分钟校验：边界值 10、1440 可保存，9、1441、空值、小数拒绝并提示；Host 使用同一 schema 拒绝越界设置；时长增减生效，以及关闭后保留时长。
- 进行中 Turn、待审批或提问、运行中 Subagent、steering 待发送或 Host 操作占用计数非 0 时不关闭。
- 超时时间调到最小时，持有 Session 引用的长操作（恢复、fork、历史读取、委派 send）跨过阈值也不会被关闭；`turn/start`、`turn/steer` 从 `resolve()` 到 Turn 开始的空窗内不会被关闭；占用在异常路径下也在 `finally` 释放。
- Renderer 只向本地 Host 下发设置。
- Renderer 与 Host 使用同一 `shared-contracts` schema 校验。
- `creating`、缺少 Native Session 引用、有持久化错误的 Thread 不关闭；关闭期间新增持久化或输出错误时不移除实例。
- 空闲不足配置时长不关闭；任一活动事件重置计时，长操作结束后重新计时。
- 满足条件时只关闭一次，关闭后 Thread 从 Runtime 移除。
- 关闭期间到达的请求等待关闭完成后恢复，不重复启动 Session。
- 关闭及输出 drain 失败或超时后，所有执行实例访问入口被 Host 拒绝，不创建新 Session；底层迟到结果不能自动解除失败状态。
- 回收与删除、替换、归档、设置关闭和 Host 退出并发时遵守协调规则，旧关闭任务不能移除新实例。
- Subagent 子 Thread 不参与释放。
- 释放后各恢复入口能恢复原 Native Session；多轮释放恢复不累积定时器、回调或旧 Session 引用。
- Host 退出时停止检查。

真实环境验证：

- 所有 Adapter 均需覆盖“创建 → 关闭 → 原 Native Session 恢复 → 继续发送消息”的生命周期测试，以及重复循环中的旧引用、回调和资源清理；不能仅以存在 `close()` / resume 方法作为支持依据。
- 为所有 Harness 建立真实验证清单，逐个核对可释放资源范围、恢复后的可继续对话行为，以及其他会话不受影响；独立进程型确认进程退出，共享进程型确认单会话关闭不误杀共享服务。
- 确认 Desktop 在 Thread 被静默释放后，重新打开、发送消息和后台读取的交互正常。
- 环境不可用的 Harness 明确记录为未验证及阻塞原因，不以其他 Harness 的测试替代，也不宣称全部通过。

测试命令在实施时从仓库 `package.json` 和测试配置选择。

## 9. 已确定决策

- 范围：全部功能仅针对本地 Host，远程 Host 不在范围内；面向所有外部 Harness。
- 入口：现有“外观”页，显示名改为“通用”，内部 ID 保持 `appearance`。
- 开关：自动释放默认关闭。
- 超时时间：分钟数值输入框（不用下拉框），默认 30 分钟，范围 10～1440 分钟整数。
- 存储：Renderer localStorage 保存，下发给本地 Host，Host 仅保存在内存；未采用在 `~/.codexhost` 新增配置文件的方案。
- 协调：未完成的 Host 操作以复用 `DesktopRequestQueue` 加按 Thread 占用计数保护，不以空闲时长兜底。

当前无待定产品决策；真实环境验证仍未完成（见第 11 节）。

## 10. 总结

本方案在“通用”设置页提供默认关闭的自动释放开关及可修改的空闲超时时间（默认 30 分钟），全部功能仅针对本地 Host。以用户显式开启和明确提示为前提，使用 Host 已知的 Turn、Subagent、steering 和持久化状态，并以复用 `DesktopRequestQueue` 加按 Thread 占用计数保护进行中的 Host 操作，优先复用现有 `close()` 与 `resolve()` 恢复路径，不引入 Adapter 安全探针或原生退订语义。设置保存在 Renderer localStorage，并通过新增的 codexhost 请求下发给本地 Host，所有 Adapter 均需验证关闭恢复行为，必要修正按结果确定。代价是可能停止会话启动的服务和后台任务，以及恢复时的等待；这些通过设置项旁的问号浮窗告知用户。

## 11. 实现与验证进展

实现位置：

- `shared-contracts/src/idle-release.ts`：共用 schema、默认值和设置请求名称。
- `renderer-extension/src/renderer-idle-release-preference.ts`：存储、连接下发、多窗口同步与失败状态；`settings/idle-release-controls.ts`：开关、分钟输入、问号浮窗说明和同步状态。
- `renderer-extension/src/settings/preference-ui.ts`：分组卡片、开关、带单位数字输入、问号浮窗等设置页小组件，使用 Tailwind 工具类；`settings/tailwind.css` 与 `scripts/tailwind-esbuild-plugin.mjs`：Tailwind 编译接入，renderer 构建改为 `scripts/build.mjs`，相关 e2e 打包同样接入插件；发布包新增 `tailwindcss-LICENSE.txt`。
- `host-runtime/src/external-thread-idle-release.ts`：每分钟检查、占用计数、关闭/drain 超时和失败隔离；`ExternalThreadRuntime` / `AppServerHost` / 委派入口只增加必要接线。
- 不修改 Adapter，不新增配置文件、不新增原生安全探针、不接入 Desktop 退订语义。
- 后续审查修正：异常退出时先关闭 steering 等待器再 drain 操作，避免无谓等待旧 Turn 的取消超时；本地客户端的无 policy 辅助查询复用已有缓存，不因本地/远程路由切换清空方法支持记录，真实连接或显式 policy 变化仍使缓存失效。两项均有回归测试。

已执行的验证：

- `npm run typecheck`、`npm run lint`（含依赖边界检查）、`npm run build:renderer`。
- Host 回收/恢复/委派及 Renderer 设置、客户端和路由的聚焦 Vitest 测试：17 个文件、367 项通过，覆盖假时钟、长操作、输出 drain、失败/超时、旧实例隔离、原身份恢复及继续发送。
- 所有 11 个 Adapter 的现有关闭/恢复相关聚焦测试：16 个测试文件，107 项通过，445 项因名称筛选未运行。它们不是“所有真实 Harness 已完成整条自动释放流程”的证明。
- `renderer-idle-release.spec.ts` 浏览器测试 3 项通过：问号浮窗显示、数值校验、开启无弹窗即生效、持久化/重载、多窗口同步、旧 Host 不支持提示；`renderer-settings-accounts.spec.ts` 3 项通过。设置页 UI 改版后另以临时截图用例目视检查深色中文、浅色中文、深色英文三种状态。
- 设置页 UI 改版后：`renderer-extension` 与 `tests/release` 的 Vitest 除下述既有失败外全部通过（含发布包许可证数量断言更新）；依赖边界检查通过。

未通过或未执行的验证：

- 额外运行的既有 `renderer-binding-startup.spec.ts` 5 项失败：`about:blank` 测试页面中，既有 `installReasoningTranscriptSoftWrap()` 直接读取 localStorage 抛出 `SecurityError`，导致绑定未安装。已在未修改基线 `7b630f6e` 的隔离副本复现首项相同异常；本 PR 不扩大范围修改该既有问题。
- 以下失败在未修改的 HEAD 隔离 worktree 中同样复现，与设置页改版无关：`renderer-external-queue.test.ts` 4 项；`renderer-binding-startup.spec.ts` 与 `renderer-chat-composer-isolation.spec.ts` 共 6 项；`renderer-usage-notification.spec.ts` 因打包未配置 `.svg` loader 无法构建。
- 未启动真实 Codex Desktop，也未运行任何使用真实 Harness/账号的端到端自动释放验证，以免中断当前会话或启动付费请求。因此 Pi、OMP、Claude Code、CodeBuddy、Cursor、Grok、Hermes、Kiro、OpenCode、Antigravity、DeepSeek Harness 的真实资源释放范围、连续恢复和其他会话不受影响仍逐项待验证。
- 全量测试、Rust 构建/测试未运行；没有 Rust 改动。
