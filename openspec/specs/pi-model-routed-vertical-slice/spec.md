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

对已归属 Pi的 Thread，Host Runtime MUST把用户文本交给真实本地 `pi --mode rpc` Native Session，并 MUST把 Pi产生的文本增量、Tool生命周期、可靠File Change、阻塞式Question、完成和明确错误转换为当前 Codex UI可消费的最小 app-server事件或Server Request。Pi Harness MUST拥有 Agent Loop；请求 MUST NOT回退给 Codex Harness。相同 Host Thread的后续 Turn和Interaction MUST继续使用相同 Pi Native Session。

#### Scenario: Pi首轮文本回复

- **WHEN**用户在新 Pi Thread发送第一条文本消息
- **THEN**Pi Adapter MUST在真实 Pi Native Session执行 Agent Loop
- **AND**Codex UI MUST显示来自 Pi的文本增量和唯一完成结果或明确错误

#### Scenario: 同 Thread第二轮

- **WHEN**首轮完成后用户在同一 Pi Thread发送第二条文本消息
- **THEN**该 Turn MUST进入与首轮相同的 Pi Native Session
- **AND**返回事件 MUST继续关联当前 Host Thread且不得进入官方 Codex Agent Loop

#### Scenario: Pi用户Extension发起阻塞式Question

- **WHEN**Pi中已有的用户Extension在活动Turn中发出`select`、`confirm`、`input`或`editor` Extension UI Request
- **THEN**Pi Adapter MUST把它映射为属于同一Host Turn的Question
- **AND**Codex UI MUST显示原生用户输入界面并把回答精确返回同一个Pi原生请求

#### Scenario: Question早于Prompt Response

- **WHEN**Pi Extension在Prompt preflight中发出Question且Pi Prompt Command尚未返回
- **THEN**Host MUST已经建立Turn与Interaction路由并允许Desktop回答
- **AND**系统 MUST NOT因互相等待Prompt Response和Question Response而死锁

#### Scenario: codexhost不向Pi注入Question Tool

- **WHEN**Host启动Pi Native Session
- **THEN**启动参数 MUST NOT包含codexhost拥有的`--extension`
- **AND**Pi可用Tool集合 MUST只来自Pi默认能力和用户原有配置
- **AND**Question映射 MUST只在Pi实际发出Extension UI Request时发生

#### Scenario: 当前 PoC不伪造未实现能力

- **WHEN**Pi产生Approval、Snapshot、Resume、Fork或本change未接管的行为
- **THEN**系统 MUST NOT伪造为已支持的Codex UI能力
- **AND**MUST返回明确受限结果或按已评审的最小错误语义终止当前操作

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

### Requirement: Selected Pi transport Model preserves Harness ownership
An explicitly selected Pi Model carrier SHALL route to the Pi Harness exactly like `codexhost/pi-native`, SHALL carry only an opaque Harness Model Ref, and SHALL NOT be treated as a Codex Model, Pi Provider, Account, Billing Source, or permission route.

#### Scenario: New Pi Thread carries an explicit Model Ref
- **WHEN** `thread/start.params.model` contains a valid selected Pi transport carrier
- **THEN** Protocol Facade decodes Pi Harness ownership and the opaque Model Ref in the same request
- **AND** it opens the Pi Session with that Ref without forwarding the request to the official Codex app-server

#### Scenario: Selected carrier is malformed
- **WHEN** a `thread/start` Model resembles a selected Pi carrier but has a missing, oversized, or invalid Model Ref
- **THEN** Protocol Facade rejects the Pi creation explicitly rather than forwarding it as an official Codex Model

#### Scenario: Later Turn carries the selected Pi carrier
- **WHEN** `turn/start` for an existing Pi Thread carries a valid selected Pi Model override
- **THEN** Host verifies or applies that Ref through the owned Pi Session before accepting the Agent Loop
- **AND** Thread Harness ownership remains Pi regardless of the current page Model state

### Requirement: Pi Model selection never falls back to Codex
Pi Model inspection, create-time application, and Idle Session selection SHALL execute only through PiAdapter and Pi native RPC behavior. Any failure SHALL remain a Pi error and SHALL NOT retry, inspect, or execute through the Codex Harness.

#### Scenario: Draft-selected Pi Model is unavailable at first Turn
- **WHEN** Pi rejects or cannot confirm the Model selected in the create carrier
- **THEN** the first Turn is rejected before acceptance or fails with an explicit Pi error according to the established acceptance boundary
- **AND** the official Codex Agent Loop receives neither the Thread creation nor the Turn

#### Scenario: Existing Session selection is busy
- **WHEN** a Model selection request targets a Pi Session with an active Turn
- **THEN** Host returns the normalized busy error and leaves the current Pi Model and Turn unchanged

#### Scenario: Codex request remains official
- **WHEN** a Codex-owned Thread uses an official Model value
- **THEN** the request continues transparently through the stock app-server and PiAdapter is not inspected or opened

### Requirement: Pi history uses the active Entry branch
PiAdapter SHALL read Pi Entries and active leaf, traverse only the active parent chain, group each visible User Message Entry with its following native output until the next active User Entry, and produce a deterministic Host Snapshot without treating append order or `get_messages` as the complete history source.

#### Scenario: Pi Session contains an inactive branch
- **WHEN** `get_entries` contains Entries not present in the active leaf ancestry
- **THEN** PiAdapter SHALL omit those Entries from the current Snapshot
- **AND** NativeTurnRefs for the active branch SHALL remain based on stable User Entry IDs

#### Scenario: Pi history is read after native continuation
- **WHEN** the same Native Session gained Turns outside codexhost
- **THEN** a resumed Snapshot SHALL preserve prior identities and append mappings for the new active Turns

### Requirement: Pi emits real-time Native identity and Checkpoints
After a live Pi Turn reaches stable settlement, PiAdapter SHALL read the persisted active Entries, identify that Turn's stable User Entry, and emit a NativeTurnRef plus a distinct exact NativeCheckpointRef before successful Host completion is exposed.

#### Scenario: Successful live Pi Turn settles
- **WHEN** the User Entry and completed active context are visible in Pi Entries
- **THEN** terminal output SHALL contain the same NativeTurnRef and Checkpoint returned by a later Snapshot

#### Scenario: Pi Turn cannot be aligned
- **WHEN** the accepted persisted Turn cannot be uniquely matched to a new active User Entry
- **THEN** PiAdapter SHALL fail or fault instead of returning an unmappable success

### Requirement: Pi performs exact native Fork or Clone
PiAdapter SHALL resolve a stable source Turn Checkpoint against the latest active branch. It SHALL call native `fork` with the next active User Entry for a non-tail target and native `clone` for the active tail, then verify a distinct derived Session whose active context ends at the selected Turn.

#### Scenario: Non-tail Pi Turn is Forked
- **WHEN** the selected Turn has a later active User Entry
- **THEN** PiAdapter SHALL Fork before that next User Entry
- **AND** the derived Snapshot SHALL include the selected Turn but no later Turn

#### Scenario: Tail Pi Turn is Forked
- **WHEN** the selected Turn is the final active Turn
- **THEN** PiAdapter SHALL Clone the active Session into a distinct Native Session
- **AND** the derived Snapshot SHALL contain the complete source active context

#### Scenario: Source receives a later Turn after Checkpoint creation
- **WHEN** a formerly tail Checkpoint is Forked after more active history was appended
- **THEN** PiAdapter SHALL resolve it as a non-tail boundary without changing the Checkpoint identity

### Requirement: Pi Fork preserves source and current files
Native Pi Fork/Clone SHALL not change source Session identity, source Entry tree, or cwd files, and the derived Pi Session SHALL be independently continuable with the Model and Thinking state effective at its context boundary.

#### Scenario: Derived Pi Session continues
- **WHEN** a new Turn runs in the Forked Session
- **THEN** only the derived Entry tree SHALL append and the source tree SHALL remain unchanged

#### Scenario: Files differ from historical Turn
- **WHEN** cwd files changed after the selected Turn
- **THEN** Pi Fork SHALL leave those current files untouched

### Requirement: Pi exact Fork supports a caller-selected cwd
PiAdapter SHALL implement caller-selected target cwd Fork through Pi's official cross-project Session Fork behavior and SHALL preserve exact Checkpoint semantics. It SHALL NOT rely on process cwd around `pi --session`, rewrite a Pi Session file, or create a Git Worktree.

#### Scenario: Tail Pi Session is Forked into another cwd
- **WHEN** `open(fork)` selects the source active tail and supplies a different target cwd
- **THEN** PiAdapter SHALL start a native `--fork` from the source Session in the target cwd
- **AND** the resulting distinct Session SHALL retain the complete active source history and execute later Turns in the target cwd

#### Scenario: Non-tail Pi Session is Forked into another cwd
- **WHEN** `open(fork)` selects a source Checkpoint with a later active User Entry and supplies a different target cwd
- **THEN** PiAdapter SHALL first create a native target-cwd Session from the source and then use Pi's native history Fork to exclude the selected Turn's successors
- **AND** the returned final Session Snapshot SHALL end exactly at the selected Checkpoint

#### Scenario: Cross-cwd Pi Fork cannot establish distinct identity
- **WHEN** native startup or exact slicing returns the source Session identity, retains a later Turn, or cannot confirm target-cwd Session state
- **THEN** PiAdapter SHALL close the attempted runtime and return an explicit failure without modifying the source Session

