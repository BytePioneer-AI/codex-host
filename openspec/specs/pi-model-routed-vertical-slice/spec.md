# pi-model-routed-vertical-slice Specification

## Purpose

定义 Launcher 级 Agent 选择、Pi Thread 进程内路由、真实 Pi 文本多轮投影和有界进程关闭的技术 PoC 行为基线，并明确该入口不替代公开 MVP 的页面内独立 Agent 选择器。

## Requirements
### Requirement: Launcher 显式选择技术 PoC Agent

在技术 PoC中，Launcher MUST要求显式选择本次受控 Desktop使用的 `codex`或 `pi` Agent，并 MUST只通过该 Desktop进程的正式 Host配置传递选择。Protocol Facade MUST在接收真实 `thread/start`的同一处理步骤中把 Pi选择绑定为内部 transport model。系统内部 MUST继续区分 Harness、Model、Provider、Account和 Billing Source。公开 MVP MUST NOT将进程级 Launcher选择声明为最终 Agent选择 UI。

#### Scenario: 启动 Pi Agent技术 PoC

- **WHEN**用户通过 `codexhost launch --agent pi`启动受控 Desktop并创建新 Thread
- **THEN**Protocol Facade MUST在该真实 `thread/start`的接收边界建立 Pi创建路由
- **AND**内部 transport model MUST只映射到 Pi Harness Native Mode，而不是伪装成 Pi实际调用的 Model

#### Scenario: 启动 Codex Agent

- **WHEN**用户通过 `codexhost launch --agent codex`启动受控 Desktop并创建新 Thread
- **THEN**创建 Request MUST保持官方 app-server行为
- **AND**Protocol Facade MUST NOT把官方 Model或 Thread改写为 Pi

#### Scenario: 不使用已失败的 Renderer或 Catalog seam

- **WHEN**当前 Desktop原生 picker不展示追加的 Pi Model或临时 native Catalog条目
- **THEN**实现 MUST报告该 picker seam为 `BLOCKED`
- **AND**MUST NOT通过 direct CDP、private Renderer dispatch seam、独立一次性 Intent消息或发送后补全传递 Harness选择

### Requirement: Shim 只在显式正式配置下启动 Host Runtime

Shim MUST在解析合法 Codex全局参数后识别 `app-server`子命令，并 MUST只在显式正式 codexhost配置下启动 Host Runtime。非 `app-server`子命令、未配置 Host Runtime的官方 CLI和直接启动的官方 Desktop MUST保持官方行为，且 MUST NOT继承 Host-only递归环境。

#### Scenario: app-server前存在全局配置参数

- **WHEN**Desktop以 `-c features.code_mode_host=true app-server`或等价合法全局参数顺序调用 Shim
- **THEN**Shim MUST识别真正的 `app-server`子命令
- **AND**显式 Host配置存在时 MUST进入正式 Host Runtime

#### Scenario: 普通官方 CLI调用

- **WHEN**Shim收到非 `app-server`子命令，或没有显式 Host Runtime配置
- **THEN**Shim MUST把原始参数和 stdio继续交给当前安装对应的官方 CLI
- **AND**MUST移除可能导致递归或 Gate/Host泄漏的内部环境

### Requirement: Protocol Facade 默认透明并显式接管 Pi资源

Protocol Facade MUST以官方 app-server为默认处理路径。除新 Pi Thread创建和已归属 Pi Thread的必要消息外，Desktop与官方 app-server之间的 JSONL frame MUST保持原始内容、顺序和方向。路由 MUST根据创建 transport model或既有 Thread归属决定，JSON-RPC `id` MUST只用于协议关联。

#### Scenario: Codex创建保持官方行为

- **WHEN**`thread/start`选择官方 Model
- **THEN**Protocol Facade MUST将 Request交给当前安装对应的官方 app-server
- **AND**官方 Response和 Notification MUST返回 Desktop

#### Scenario: 无关消息透明转发

- **WHEN**Protocol Facade收到不在显式接管清单中的有效 JSONL frame
- **THEN**该 frame MUST不经语义重写地转发到原方向
- **AND**并发消息的顺序和 JSON-RPC关联 MUST保持有效

### Requirement: Pi Thread创建不进入官方 Codex Agent Loop

当本次受控 Desktop选择 Pi Agent，或新创建 Request显式携带 Pi transport model时，Protocol Facade MUST分配 Host Thread ID、建立进程内 `Thread → Pi`归属并创建 Pi Native Session。该 `thread/start` MUST NOT进入官方 Codex app-server，也 MUST NOT为了取得 ID创建官方影子 Thread。Host Runtime MUST只返回当前 Desktop实际需要且已由 Capture评审的最小兼容创建 Response/Event。

#### Scenario: 创建 Pi Thread

- **WHEN**Protocol Facade收到本次 Pi Agent启动模式下的真实 `thread/start`，或 Request显式携带 Pi transport model
- **THEN**Host Runtime MUST创建归属于 Pi Harness的 Host Thread和 Native Session
- **AND**官方 app-server MUST NOT收到该 Pi创建 Request

#### Scenario: Pi创建失败

- **WHEN**Pi未安装、不可执行、Native Session启动失败或最小协议投影失败
- **THEN**Host Runtime MUST返回可理解的明确错误
- **AND**MUST关闭已分配的部分资源且不得留下可继续的假 Thread

#### Scenario: 后续路由固定使用 Thread归属

- **WHEN**Pi Thread已经创建并收到后续 Turn或控制消息
- **THEN**Protocol Facade MUST根据 Thread归属路由到 Pi Adapter
- **AND**MUST NOT根据页面当前 Model选择改变该 Thread的 Harness

### Requirement: Pi 首轮与第二轮文本在 Codex UI闭环

对已归属 Pi的 Thread，Host Runtime MUST把用户文本交给真实本地 `pi --mode rpc` Native Session，并 MUST把 Pi产生的文本增量、完成和明确错误转换为当前 Codex UI可消费的最小 app-server事件。Pi Harness MUST拥有 Agent Loop；请求 MUST NOT回退给 Codex Harness。相同 Host Thread的第二个 Turn MUST继续使用相同 Pi Native Session。

#### Scenario: Pi首轮文本回复

- **WHEN**用户在新 Pi Thread发送第一条文本消息
- **THEN**Pi Adapter MUST在真实 Pi Native Session执行 Agent Loop
- **AND**Codex UI MUST显示来自 Pi的文本增量和唯一完成结果或明确错误

#### Scenario: 同 Thread第二轮

- **WHEN**首轮完成后用户在同一 Pi Thread发送第二条文本消息
- **THEN**该 Turn MUST进入与首轮相同的 Pi Native Session
- **AND**返回事件 MUST继续关联当前 Host Thread且不得进入官方 Codex Agent Loop

#### Scenario: 当前 PoC不伪造未实现能力

- **WHEN**Pi产生 Tool、Question、Approval、Diff或本 change未接管的事件
- **THEN**系统 MUST NOT伪造为已支持的 Codex UI能力
- **AND**MUST返回明确受限结果或按已评审的最小错误语义终止当前 Turn

### Requirement: Host与子进程生命周期有界

Host Runtime MUST监督官方 app-server和所有 Pi子进程。Desktop输入结束、Host关闭、启动失败或协议失败后，Host MUST在有界时间内关闭相关 stdin、等待正常退出并在超时后终止本次进程树。stdout MUST保持严格 JSONL，诊断 MUST写入受控 stderr且不得包含 Prompt、Transcript、凭据或完整用户配置。

#### Scenario: 正常关闭

- **WHEN**Desktop正常退出或关闭 app-server输入
- **THEN**Host Runtime MUST有界关闭官方 app-server和本次 Pi Native Session
- **AND**不得留下本次 Host、官方 app-server或 Pi孤儿进程

#### Scenario: 子进程异常退出

- **WHEN**官方 app-server或 Pi进程在活动请求期间异常退出
- **THEN**Host Runtime MUST向 Desktop返回明确协议或 Harness错误
- **AND**MUST清理其余本次运行资源且不得在 stdout输出普通日志

