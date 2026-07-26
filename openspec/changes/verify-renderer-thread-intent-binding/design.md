## Context

当前正式代码中的 `desktop-control` 和 `renderer-extension` 仍只有 Workspace metadata；没有 CDP 连接、Renderer 注入、Agent UI 或创建绑定逻辑。Gate A 证明官方 CLI 接受 `thread/start` 并立即返回 Codex Thread ID，但当前 Shim 只做字节透明转发，不能观察或修改真实 Desktop app-server JSONL。Gate B 因此需要少量新的启动、注入和观察能力，不能把它们描述为 Gate A 已实现能力。

Paseo 当前参考快照证明了以下通用模式：pending create 按草稿身份隔离，用户发送时才快照最终 Provider、Model、Thinking、cwd 和输入，一个自包含创建请求携带创建参数，Response 完成对应请求。codexhost 只参考这些公开行为并独立实现，不复制 Paseo 的 AGPL 代码，也不把 Paseo 的 `requestId`、`clientMessageId` 与 codexhost ID 语义视为相同契约。

CodexPlusPlus 当前参考快照证明 Electron Renderer 可以通过 direct CDP target、`Page.addScriptToEvaluateOnNewDocument` 和 `Runtime.evaluate` 注入，并可以包装 `send-cli-request-for-host`、`start-thread-for-host` 或 app-server client `sendRequest` 等当前页面私有边界。它同样使用 AGPL，本项目只采用行为证据，不复制实现。具体出站边界仍必须在当前 Codex Desktop 上实测确认。

Gate B 采用一条创建通道：

```text
Renderer Composer 草稿
→ 首次发送时快照完整 CreateThreadIntent
→ 注入脚本包装当前统一出站边界
→ 同一个真实 thread/start Request 携带官方参数和 Gate-only Intent 扩展
→ Node JSONL Observer 提取并移除扩展
→ 官方 app-server
→ 同一 JSON-RPC id 的 Response 返回 Codex Thread ID
```

CDP 只用于控制和注入，不发送独立业务 Intent。Gate 不需要把两个消息合并，因此不实现 keyed join、Intent accepted/rejected、pending half、过期窗口或 Bridge session 协议。

`MVP-20` 继续由正式 Mapping Store 和 P1 Desktop/Host Runtime 重启集成测试关闭。Gate B 只报告当前运行中的 `CreateRequestId → observed Codex Thread ID → HarnessId` 证据，不分配 Host Thread ID，不实现临时持久化 ledger。

## Goals / Non-Goals

**Goals:**

- 在真实 Codex Desktop 上证明最小 direct CDP 可以连接本次启动实例、确认 Renderer target、注入 Browser asset 并在重载后重新生效。
- 捕获真实 Desktop 首次发送使用的创建 Method、参数边界、Response Thread ID 位置和首个 Turn 顺序。
- 找到当前 Desktop 实际使用的一个统一出站创建边界，并只包装该边界。
- 证明发送时快照的完整 `CreateThreadIntent` 能随同一个真实创建 Request 到达 Gate 观察器。
- 通过五类真实场景证明快速切换、并发、失败重试和重载不会改变对应请求中的 Harness 选择。
- 只把真实 Gate 已验证的最小领域契约提升到 Shared Contracts，并生成平台限定脱敏证据。

**Non-Goals:**

- 不复制 Paseo 或 CodexPlusPlus 代码，不引入其 UI、Store、Daemon、Bridge 或协议实现。
- 不建立通用 CDP client、Playwright控制路径、Fake CDP endpoint或第二套CDP fallback。
- 不建立独立 Renderer Intent业务通道、通用Bridge协议或keyed join状态机。
- 不重复 Gate A 已覆盖的完整 stderr、EOF、Crash、Server Request 和进程生命周期差分矩阵。
- 不实现正式 Agent 选择器、Model 目录、Pi Agent Loop、HarnessAdapter、Mapping Store、Protocol Core 或完整 Host Runtime。
- 不分配 Host Thread ID，不把观察到的官方 Codex Thread ID描述为外部 Host Thread。
- 不修改或重打包官方 App、`app.asar` 或官方二进制，也不用一个平台的结果推断另一平台。

## Decisions

### 1. 草稿只保存创建所需的最小状态

Gate-only Renderer 按当前 document 中可区分的 Composer 草稿隔离：

```text
selected Harness / Model / Thinking / cwd
+ draft | creating | sent | abandoned
+ 当前 CreateRequestId（仅 creating）
```

选择 Agent、切换 Model 或编辑输入只更新当前草稿。首次发送时生成新 `CreateRequestId`，快照最终选择并进入 `creating`；创建期间拒绝第二次用户提交。创建失败进入 `abandoned`，用户再次发送时重新快照并生成新 ID。页面重载销毁旧 JavaScript realm 和未完成草稿，新 document 重新注入，不为此建立跨进程 document epoch业务协议。

该模式依据 Paseo 的公开行为独立实现，不照搬其 React/Zustand 结构，也不扩展成正式产品 store。

### 2. CDP 只实现注入所需的最小 direct 路径

Gate 先确认目标 Codex Desktop 未运行，再复用 Gate A 的进程级启动和有界清理，为本次 Desktop 增加 loopback 随机 remote debugging参数、临时 `CODEX_HOME`和synthetic cwd。`CODEX_HOME`只隔离官方CLI数据，不声称隔离Electron Renderer profile。

Controller只实现：

1. 查询本次endpoint的target列表；
2. 通过进程归属、target type和页面行为确认Renderer；
3. 建立一个CDP WebSocket连接；
4. 注册new-document脚本并注入当前document；
5. 执行最小健康检查和重载后重新确认。

不因这些命令建设通用CDP抽象。target不能可靠确认、注入失败或重载后不能恢复时，当前平台Gate报告`BLOCKED`。CDP消息不承载`CreateThreadIntent`。

### 3. 只包装当前真实的统一出站创建边界

Gate先在当前Desktop做一次受控Capture，确认首次发送最终经过的最内层统一app-server发送边界和真实创建Method。实现只包装该边界，不分别为按钮、键盘或其他UI触发方式建立hook。

包装器在首次发送进入创建Method时同步完成：

1. 找到所属Composer草稿；
2. 快照最终选择并生成`CreateRequestId`；
3. 构造strict `CreateThreadIntent`；
4. 把完整Intent写入同一个创建Request的Gate-only namespaced扩展字段；
5. 调用原始发送函数并以真实Response更新该草稿。

非创建Method原样调用原始函数。当前真实出站边界不可定位或无法在调用原函数前同步修改Request时，Gate报告`BLOCKED`，不同时维护多个hook作为运行时fallback。

### 4. 创建Request必须自包含完整Intent

Gate-local Intent为：

```ts
interface CreateThreadIntent {
  requestId: CreateRequestId;
  harnessId: HarnessId;
  cwd: string;
  modelId?: string;
  thinkingOptionId?: string;
}
```

Gate验证一个namespaced Request扩展，例如：

```text
thread/start.params.codexhost.createThreadIntent
```

确切字段名属于Gate-local carrier，不提升到Shared Contracts。观察器必须从同一个Request取得完整Intent；不得从CDP binding、先行preflight、最近选择、时间窗口、FIFO、`selectedHarness`或`nextHarness`补全任何字段。

本change不实现自定义Method、synthetic model或第二carrier作为运行时备用。扩展字段无法从真实Renderer到达观察器时，当前方案在该平台`FAIL`；后续根据证据重新设计，而不是在同一实现中增加第二通道。

`CreateRequestId`标识一次创建尝试。JSON-RPC `id`只关联该协议Request与Response，首条用户消息ID和最终Host Thread ID具有不同语义，不能混用。

### 5. Gate-only JSONL Observer保持透明且无领域分配

Gate A Shim在识别app-server调用时，将本次Gate运行路由到受监督Node JSONL Observer；其他调用继续透明转发官方CLI。Observer启动当前安装对应的官方app-server，并且只增加：

- 校验目标创建Request中的strict Intent；
- 记录`JSON-RPC id → CreateRequestId/HarnessId`的当前pending关系；
- 在转发官方app-server前移除Gate-only扩展字段；
- 观察同一JSON-RPC `id`的Response Thread ID和首个相关Turn；
- 对Pi标记的observed Codex Thread，在首个`turn/start`进入官方app-server Agent Loop前返回受控Gate错误；
- 生成allowlist证据。

这是普通Request/Response关联，不是跨通道join。无关JSONL line按原顺序和内容转发；Observer不分配Host ID、不启动Pi、不执行正式Harness路由、不保存Transcript，也不实现完整JSON-RPC Peer或Protocol Facade。

Gate B只为上述新增链路补充透明转发、字段移除、Response关联和错误清理测试，不重复Gate A完整生命周期矩阵。现有Gate A测试用于发现基础能力回归。

### 6. 验证按行为收敛

普通检查覆盖：

- 发送时最终选择快照、草稿隔离、创建期间重复提交拒绝、失败后新ID重试；
- 完整Intent随同一个创建Request出现，缺失、未知或非法字段被拒绝；
- Gate扩展字段在官方转发前移除，其他字段和无关JSONL line保持不变；
- Pi标记Thread的首个Turn在官方Codex Agent Loop前被阻止；
- 两个JSON-RPC Request交错且Response反序时仍各自关联；
- Browser asset不导入Node.js、Electron或Harness能力；
- Fixture allowlist隐私校验。

不固定测试数量，不创建Fake CDP server。真实`npm run gate:b`执行五类场景：

1. **CDP注入与重载**：确认target、幂等注入，重载后新document重新注入且旧草稿不继续发送。
2. **真实首发**：捕获Method/字段/Response/首个Turn，证明完整Intent随同一Request到达并在官方转发前移除，且Pi标记的首个Turn未进入官方Codex Agent Loop。
3. **快速切换**：同一Composer发送前切换Codex/Pi，Request只包含最终选择。
4. **并发创建**：两个窗口或可区分Composer选择相反Harness，交错创建、反序完成仍各自正确。
5. **失败重试与重载隔离**：一个创建受控失败，再次发送使用新ID；重载后的请求不复用旧草稿。

若当前Desktop无法形成两个可区分Composer，则并发场景报告`BLOCKED`，不以Hermetic测试冒充真实Renderer证据。

### 7. 证据不声称Renderer profile完全隔离

真实运行目录为`.codexhost/gate-b/<run-id>/`。Gate可以使用当前Desktop Renderer profile以保留真实登录状态，但CDP只能执行target确认、注入、健康检查和synthetic Composer操作。不得采集无关DOM、账号信息、项目列表、Local Storage、完整Console、网络流量或页面截图。

可提交Fixture只保存平台、OS/Desktop/CLI版本、Method、字段名和类型占位符、五类场景结果与布尔不变量；Prompt、Transcript、DOM正文、真实Thread/RPC ID、绝对路径、环境和token不得提交。

Gate结论：

- `PASS`：五类真实场景全部通过，并证明完整Intent存在于同一个真实创建Request且没有串线；
- `FAIL`：环境足以验证，但Request扩展无法到达观察器，或发生错误绑定、重复创建、旧状态污染或安全边界破坏；
- `BLOCKED`：已有实例、安装、CDP、Renderer出站边界、权限或多Composer条件阻止取得结论。

### 8. Shared Contracts只提升领域值

只有当前平台真实Gate`PASS`后，Shared Contracts才增加`CreateRequestId`和strict `CreateThreadIntent`。Gate-only Request扩展字段、Codex Method Schema、CDP target、页面身份、注入健康消息和Observer控制信息继续位于`tools/gate-b/`。

## Risks / Trade-offs

- [当前Desktop的direct CDP target或私有发送边界变化] → 以健康检查和真实Capture失败封闭；不维护多hook运行时fallback。
- [Request扩展在到达Observer前被页面桥移除] → 当前平台Gate`FAIL`并保留实际Capture，不增加第二业务通道补偿。
- [Gate A路由增加回归] → app-server分支保持Gate-only，其他调用继续官方路径，并运行现有Gate A回归。
- [真实Gate接触现有Renderer profile] → 限制CDP操作和allowlist证据，不声称profile隔离，不采集无关页面数据。
- [Windows通过被误认为跨平台通过] → 报告必须平台限定，macOS需要独立真实运行。
- [Gate B通过但映射仍不耐久] → `MVP-20`仍由正式Mapping Store和P1重启集成测试验证。

## Migration Plan

1. 增加Gate-local Intent、草稿生命周期、同Request carrier和Observer的确定性测试。
2. 为Gate启动路径增加最小CDP参数和Node Observer路由，实现direct CDP target确认与注入。
3. 捕获当前真实出站边界，只实现一个创建Request包装器和一个namespaced扩展。
4. 运行五类真实场景并生成平台限定结论。
5. 只有`PASS`后提升`CreateRequestId`和`CreateThreadIntent`并更新文档；`FAIL`或`BLOCKED`不推进正式Agent UI。

## Open Questions

- 当前Windows/macOS Desktop分别接受哪种本次进程级remote debugging参数？
- 当前Renderer首次发送最终经过哪个统一app-server发送边界，真实创建Method和首个Turn顺序是什么？
- namespaced完整Intent扩展能否从该边界到达Gate JSONL Observer？
- 当前Desktop能否形成两个可区分Composer；若不能，最小可重复人工步骤是什么？
