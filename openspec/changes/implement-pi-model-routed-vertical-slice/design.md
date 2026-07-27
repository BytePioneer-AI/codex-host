## Context

Gate A 已证明 Codex Desktop 可以通过 `CODEX_CLI_PATH` 使用 Shim，Gate C 已证明本地 `pi --mode rpc` 能执行真实 Agent Loop。Renderer carrier 调查进一步证明自定义字段可到达 app-server 代理，但也证明当前私有 seam 是 `thread-prewarm-start` 预热流程，不能稳定表达用户发送时的最终 Harness 选择。

PRD 在技术 PoC层允许临时使用非最终交互。真实验证表明当前 Desktop既不展示追加的 `model/list`条目，也不展示通过临时 `model_catalog_json`加载的完整 Pi Catalog条目。因此原生 picker seam明确 `BLOCKED`。当前技术 PoC改由 Launcher显式选择本次受控 Desktop的 Agent，并在 `thread/start`接收边界绑定内部 transport route；该入口不改变领域模型，也不替代公开 MVP的页面内独立 Agent选择器。

本 change 只完成当前进程内的 Pi 文本垂直链路。正式独立 Agent 选择器、持久化、完整工具/提问/Diff/Fork 和发布级兼容不在本 change 中。

## Goals / Non-Goals

**Goals:**

- 不使用 direct CDP、private Renderer seam或无效的 Catalog增强，通过 Launcher显式选择技术 PoC Agent。
- 在真实 `thread/start`的接收边界将 Pi选择原子绑定为内部 transport model。
- Codex 请求保持官方 app-server 行为。
- Pi 创建和 Turn 不进入官方 Codex Agent Loop。
- Pi 首轮和同 Thread 第二轮真实调用本地 Pi Native Session，并在 Codex UI 显示文本增量、完成或明确错误。
- 正常关闭时 Host、官方 app-server 和 Pi 子进程有界退出。

**Non-Goals:**

- 不把 Pi 在领域模型中定义为 Model，也不声称特殊 Model 项是公开 MVP 的最终 Agent UI。
- 不实现页面内 Renderer extension、独立 Agent选择器或 Bridge Contract；Launcher选择仅属于技术 PoC。
- 不实现 Mapping Store、重启恢复、Thread 列表合并、Rename、Archive、Fork 或 Detach。
- 不实现 Tool、Question、Approval、Diff、Skills 或完整历史投影。
- 不建立 Desktop Build 白名单、多层协议 fallback 或通用兼容矩阵。

## Decisions

### 1. 正式 seam 是 app-server Protocol Facade

Desktop 仍通过进程级 `CODEX_CLI_PATH` 启动 Shim。Shim 解析 Codex 全局参数并识别 `app-server` 子命令：

```text
Codex Desktop
→ codexhost Shim
→ Host Runtime
├→ official codex app-server
└→ Pi Adapter
```

只有显式 codexhost 启动配置进入 Host Runtime。普通 `codex` CLI、直接启动官方 Desktop 和非 `app-server`子命令不读取 Host-only 环境并继续进入官方 CLI。

Host Runtime 是正式模块，不使用 `CODEXHOST_GATE_B_*` 命名，也不依赖 `tools/gate-b`。

### 2. 先捕获当前协议形状，再实现窄投影

实现前使用当前安装对应的官方 CLI捕获并评审以下不含 Prompt 正文的结构事实：

- `model/list` Request/Response Method 和 Model 条目必需字段；
- Model 选择在 `thread/start` 中的字段位置；
- 官方 `thread/start`成功 Response 和创建通知的字段形状；
- `turn/start`文本输入字段位置；
- 文本增量、Item 完成、Turn 完成和错误通知的 Method/必需字段。

Capture 只记录 Method、字段名、类型、次数和关联方向，不提交账号、Prompt、Transcript、真实 Thread ID、凭据或完整用户配置。

当前 Desktop已真实证明不展示追加的 `model/list`或临时 native Catalog条目，该 picker seam记录为 `BLOCKED`。本 change不回退 private Renderer seam，改由 Launcher显式选择本次技术 PoC Agent。

### 3. Pi transport model ID 只属于协议适配

Host Runtime 保留一个不会与官方 ID 冲突、且符合 Codex `provider/model`单斜杠约束的 transport model ID：

```text
codexhost/pi-native
```

该 ID 在 Protocol Facade 内解码为：

```ts
{
  harnessId: "pi",
  routeMode: "native"
}
```

Pi 的实际 Model、Provider、认证和 Billing Source仍由 Pi Native Mode 决定，并从 Pi 真实状态读取。Host Runtime 不把 transport ID 当作 Pi 实际 Model ID。

Launcher通过 `--agent codex|pi`传递本次受控 Desktop的稳定 PoC选择。Host Runtime在接收真实 `thread/start`的同一处理步骤中应用该选择，不维护可被某个请求消费的一次性 `nextHarness`，也不通过跨通道 join补全 Intent。

### 4. 路由依赖 Thread 归属，不依赖当前 Model 选择

创建时：

```text
本次启动 Agent == pi
或 thread/start.params.model == codexhost/pi-native
→ 分配 Host Thread ID
→ 记录 Thread → Pi
→ 建立 Pi Native Session
→ 不转发官方 thread/start
```

其他 Model：

```text
thread/start
→ 原样转发官方 app-server
```

创建后：

```text
turn/start.params.threadId
→ 查询进程内 Thread 归属
→ Pi Thread 进入 Pi Adapter
→ 非 Pi Thread 原样转发官方
```

后续 Turn 不再读取页面当前 Model 选择来判断 Harness。Thread 的 Harness 在首次 Turn 后固定；Model transport ID 只负责新 Thread 的技术 PoC 创建意图。

### 5. Host Thread 和 Native Session 不使用官方影子 Thread

Pi 创建不向官方 app-server发送 `thread/start`，也不为取得 ID 创建隐藏 Codex Thread。Host Runtime 生成符合当前协议字段约束的 Host Thread ID，并维护最小进程内状态：

```ts
Map<HostThreadId, {
  harnessId: "pi";
  nativeSessionRef: PiNativeSessionRef;
  state: "starting" | "idle" | "running" | "failed" | "closed";
}>
```

进程退出后不恢复是本 change 的明确限制。创建或首轮失败必须返回明确错误并关闭已创建的 Pi 资源，不能留下可继续但无 Native Session 的假 Thread。

### 6. Pi Adapter 只实现文本闭环

Pi Adapter 的最小正式 interface 由真实调用方定义，概念上只需要：

```ts
openNativeSession(options)
startTextTurn(session, input, callbacks)
closeSession(session)
```

实现复用 Gate C 已验证的 Pi RPC事实，但生产代码位于 `packages/adapters/pi`。它负责：

- 启动当前已安装的 Pi；
- 使用 Native Mode 的 Model、Provider、认证和配置；
- 严格 LF JSONL framing；
- 关联 RPC Command 和 Agent 事件；
- 输出文本增量、完成和明确错误；
- 同一 Host Thread 复用同一 Native Session；
- 有界取消和关闭。

Host Runtime 不解释 Pi 的 Agent Loop，也不把 Pi 请求改由 Codex执行。

### 7. Protocol Facade 默认透明，显式接管最小 Method

本 change 的接管清单仅包括：

- 本次 Pi Agent启动模式下的新 `thread/start`；
- 显式携带 Pi transport model的新 `thread/start`；
- 已归属 Pi Thread 的 `turn/start`；
- 当前最小链路实际需要的 Pi取消/关闭消息（仅在真实 Capture 证明必需时）。

其他 Desktop Request、Notification、Server Response、Server Notification和 Server Request默认保持原始 frame、顺序和方向转发官方 app-server。

JSON-RPC `id`只用于协议关联，不承担 Harness ownership。stdout 保持严格 JSONL；诊断只写 stderr，且不得包含 Prompt、Transcript 或凭据。

### 8. 最小真实验收优先于通用抽象

真实验收顺序：

1. Codex Model 创建并完成一轮官方回复；
2. Pi transport model 创建，确认官方 app-server 未收到该 `thread/start`；
3. Pi 首轮文本在 Codex UI显示；
4. 同一 Pi Thread 第二轮继续进入相同 Native Session并显示；
5. 关闭 Desktop，确认 Host、官方 app-server 和 Pi无本次孤儿进程。

在该链路通过前，不提升完整 HarnessAdapter、不实现持久化，也不扩建大规模故障矩阵。

## Risks / Trade-offs

- [特殊 Model 项混淆 Agent 与 Model] → 只允许用于技术 PoC，UI 名称明确标注 Pi Agent；领域内部使用 Harness route；公开 MVP必须替换为独立 Agent 选择器。
- [Desktop 对追加 Model 有隐藏校验] → 先做真实 `model/list`原型；失败即停止，不回退 private Renderer seam。
- [合成 Pi Thread 需要更多官方事件] → 以当前版本真实 Capture 为准，只实现 UI进入可用状态所需的最小 Response/Event；未知形状不猜测。
- [官方协议双向且并发] → Protocol Core集中拥有 ID关联和显式接管；非接管消息原始转发，不在多个模块重复解析。
- [进程内映射无法恢复] → 作为本 change 的明确限制；MVP通过后再进入 Mapping Store change。
- [Pi Native Session启动失败] → 返回明确创建/Turn错误，关闭部分资源，不伪装为 Codex或成功。

## Migration Plan

1. 归档未完成的 Renderer carrier调查，不提升其 capability spec。
2. 捕获并评审当前 app-server Model、Thread和文本事件的最小协议形状。
3. 实现正式 Shim → Host Runtime 入口和默认透明双向转发。
4. 记录当前 Desktop原生 picker不展示追加 Model/Catalog的 `BLOCKED`事实，停止该 seam。
5. 通过 Launcher显式 Agent选择实现 Pi `thread/start`和进程内 Thread归属，不创建官方影子 Thread。
6. 接入 Pi RPC文本 Turn并投影首轮与第二轮。
7. 完成 Codex/Pi真实验收和有界进程清理。
8. PoC通过后新建独立 Agent选择器与持久化 change，不继续把 transport model当作最终产品语义。

## Open Questions

- 当前 CLI 的 `model/list`条目哪些字段是 Desktop显示与选择所必需的？
- Pi transport model选择是否稳定出现在 `thread/start.params.model`，还是由当前 Desktop在其他官方字段表达？
- 当前 Desktop创建一个非官方 Thread最少需要哪些 Response和 Notification？
- 当前文本渲染链路最少需要哪些 Item/Turn事件和字段？
- Pi首轮是由 `thread/start`携带初始输入，还是 Desktop随后发送独立 `turn/start`？该事实由 Capture决定。
