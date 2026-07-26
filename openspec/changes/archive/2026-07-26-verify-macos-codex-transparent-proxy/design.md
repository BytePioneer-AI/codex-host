## Context

Windows Gate A 已在 Windows Codex Desktop `26.721.4979.0` 和 Codex CLI `0.146.0-alpha.3.1` 上证明 `CODEX_CLI_PATH`、透明字节转发、官方 CLI 差分和 Job Object 清理成立。现有实现已经包含可复用的 Shim 字节泵、官方 CLI 目标校验、递归防护、Probe Capture 和差分运行器，但 `platform` 的安装/进程/子进程保护目前只有 Windows 实现，非 Windows 路径明确返回 `Unsupported`；Gate 编排与证据 Schema 也仍带有 Windows 专属字段。

当前开发机的只读发现表明：系统为 macOS `15.6.1` arm64，官方 App 位于 `/Applications/Codex.app`，Bundle ID 为 `com.openai.codex`，主可执行文件为 `Contents/MacOS/ChatGPT`，配套 CLI 为 `Contents/Resources/codex`，两者均为 arm64 Mach-O；当前 Desktop 版本为 `26.721.41059`，CLI 为 `0.146.0-alpha.3.1`。运行中的进程也显示 Desktop 直接启动该 bundle 内 CLI，并使用与 Windows 已观察到相同的 `-c features.code_mode_host=true app-server --analytics-default-enabled` 参数形状。这些只读事实用于规划，但不能替代关闭现有实例后的隔离启动、环境继承和生命周期 Gate。

本变更必须避免两个极端：一是复制一套 macOS 专用 Shim 和差分工具，造成生产逻辑分叉；二是为了表面统一而把 Windows Job Object 语义硬套到 POSIX。正确边界是共享代理语义，平台分别实现安装、启动和进程监督。

## Goals / Non-Goals

**Goals:**

- 在真实 macOS 官方 Codex Desktop 上独立证明进程级 `CODEX_CLI_PATH` 接入、官方 CLI 透明代理和完整生命周期是否成立。
- 最大化复用 Windows 已验证的 Shim、Capture、差分和测试基础，并持续运行 Windows 回归测试。
- 将共享 Shim 核心以及 macOS 安装发现、启动和进程监督实现成后续生产 Launcher/Shim 可复用的原生模块。
- 将真实安装探测、证据捕获、脱敏、差分编排和 Gate 报告与生产运行路径明确隔离。
- 对正常退出、EOF、取消、信号、Crash、强制终止和子进程逃逸进行有界收敛验证，不留下 Probe 创建的孤儿进程。
- 无论结果为 `PASS`、`FAIL` 或 `BLOCKED`，都产出可审查、脱敏且足以支持下一架构决策的结论。

**Non-Goals:**

- 不实现 Protocol Core、app-server JSON-RPC 转换或资源路由。
- 不接入 Pi，不定义 HarnessAdapter、Mapping Store 或 Shared Contracts。
- 不注入 Renderer，不实现 Agent 选择器或首次发送绑定。
- 不实现安装器、私有 Node.js Runtime、代码签名、公证、更新或发布目录。
- 不修改、重签、重打包官方 Codex App，也不修改用户级/系统级环境。
- 不把当前 Mac 的版本、CPU 或安装路径固化为产品白名单和兼容矩阵。
- 不借 macOS 工作重写已通过的 Windows 平台能力，除非共享抽象所需且有等价回归证据。

## Decisions

### 1. 先提取共享代理核心，再增加 macOS 平台实现

现有 `shim` 中以下行为属于跨平台生产候选能力：原 argv 转发、明确官方 CLI 目标、递归校验、`CODEX_CLI_PATH` 清除、stdin/stdout/stderr 字节泵、EOF 半关闭、输出排空和退出状态传播。实现 macOS 时必须复用同一个核心，不建立 `macos-shim` 或复制事件循环。

`platform` 则只统一可观察契约，不强制相同机制：Windows 继续使用 Job Object；macOS 使用 process group、POSIX 信号和进程树观察。共享抽象应支持“启动前配置隔离边界、启动后持有监督句柄、正常等待、有界终止、强制终止和身份复核”，而不是只保留当前 Windows 的“spawn 后附加 Job”形状。

替代方案是保持现状并在 macOS 分支复制 `run_proxy()`。这会让字节泵、EOF 和退出逻辑长期分叉，后续 Protocol Core 接入时产生两个生产 Shim，因此拒绝。

### 2. 明确区分生产候选代码与 Gate-only 设施

生产候选代码位于 Rust crates：

- `platform`：App bundle/CLI 发现、路径与身份校验、进程查询、启动策略、process group/Job、信号和有界清理；
- `launcher`：调用平台能力启动官方 Desktop、拒绝污染已有实例、管理 Desktop 生命周期；
- `shim`：透明启动和监督官方 CLI，未来仅在 app-server 分支改为连接 Host Runtime。

Gate-only 设施位于 `tools/gate-a`、`tests/fixtures` 和差分测试：Capture 模式、原始证据目录、专用 Prompt、脱敏、Golden、人工检查清单和 Gate 报告。Probe 专用环境字段不能成为生产发现官方安装的必要条件。

替代方案是把 Probe 捕获长期嵌入正常 Launcher/Shim 默认路径。该方案会增加隐私面和生产耦合，因此拒绝；Capture 必须显式启用且默认关闭。

### 3. macOS 安装发现以 App bundle 身份和内部一致性为准

发现流程只读检查受支持应用目录中的 `.app` 候选，并验证：

- `Info.plist` 可读；
- `CFBundleIdentifier == com.openai.codex`；
- `CFBundleExecutable` 指向 bundle 内存在且可执行的 Mach-O；
- `Contents/Resources/codex` 存在、可执行且位于同一 bundle；
- 版本、架构、规范化路径和签名摘要可用于证据与诊断。

当前版本不允许回退到 `PATH`、Homebrew 或用户全局 `codex`。若发现多个合法候选，必须按明确、可诊断的安装位置策略选择或返回歧义，不按修改时间猜测。代码签名用于确认当前证据和拒绝明显不匹配的候选，但不建立 Desktop 版本白名单。

`Info.plist` 解析和签名/Bundle 查询必须使用 Rust 库或 macOS 原生 API；正式运行路径不以 shell、PowerShell 或临时脚本承载业务逻辑。Gate 工具可以调用系统诊断命令交叉验证，但不能成为生产发现的唯一实现。

### 4. 用对照实验选择启动方式，不预先假定 LaunchServices 或直接执行一定成立

在关闭现有 Desktop 后，对两个候选路径分别进行隔离实验：

1. LaunchServices 新实例启动，使用其受支持的进程级环境传入方式；
2. 直接执行 `Contents/MacOS/<CFBundleExecutable>`，由 Rust `Command` 传入子进程环境。

每条路径记录返回句柄/PID、实际 Desktop PID、单实例行为、父子关系、process group、Shim Capture 和退出行为。最终生产候选路径必须同时满足：不复用旧实例、环境只作用于本次启动、Shim 可证明收到环境、官方 App 功能正常且 Launcher 可以可靠观察生命周期。

若只有一条路径满足，选择该路径并记录另一条不采用的原因；若两条都满足，优先选择生命周期归属和错误传播更明确的一条；若两条均不能证明环境继承，则 Gate 为 `FAIL` 或 `BLOCKED`，不得用 `launchctl setenv`、`open` 前修改全局环境或改写 App bundle 绕过。

### 5. 现有实例检测和 PID 归属不能只依赖进程名

`ChatGPT`、`Codex (Renderer)` 等名称并不足以证明进程属于目标 App。macOS 平台层使用 PID、父 PID、process group、规范化可执行路径和目标 bundle root 建立进程快照。启动前若发现目标 bundle 的主进程已运行，Launcher 必须拒绝复用或终止它。

启动后仅监督本次新实例根进程及其可证明的后代。发送信号或强制清理前再次校验 PID 身份，避免 PID 复用导致误杀。实现使用 macOS 原生进程 API，不恢复 Linux `/proc` 占位，也不在正式运行时解析 `ps` 文本。

### 6. macOS 使用“预先建立 process group + 后代观察”收敛生命周期

对于 Shim 启动的官方 CLI，隔离边界必须在 `spawn` 前配置，避免先启动再设置 group 的竞态。正常取消按以下顺序执行：

```text
停止接受新输入并关闭 stdin
→ 向受监督 process group 发送温和信号
→ 有界等待并排空 stdout/stderr
→ 超时后发送强制信号
→ 复核已记录后代均已退出
```

process group 是主要信号边界，后代进程快照是处理原生程序自行创建新 group 或重设父子关系时的验证和兜底。Launcher 对 Desktop 生命周期采用相同原则，但只处理本次启动且身份仍匹配的进程集合。

Windows 继续使用 kill-on-close Job Object，不为了代码统一改用轮询进程树。公共测试验证相同的可观察结果：有界关闭、退出状态明确、无本次调用创建的孤儿进程。

### 7. Unix 信号和退出状态保持语义透明

Shim 必须处理 Desktop 可能发送的 `SIGTERM`、`SIGINT`、`SIGHUP` 等受支持信号，将取消转发给受监督 CLI group，并保证自己只完成一次终态收敛。官方 CLI 普通退出时返回相同退出码；CLI 因信号退出时，Shim 必须保留可诊断的信号分类并以非成功终态退出，在可安全实现时复现等价信号终止语义，而不是返回成功或向 stdout 注入错误 JSON。

信号处理采用受审查的 Rust/POSIX 封装，并隔离必要的 `unsafe`；不得从异步信号处理器直接执行非 signal-safe 的 Rust 清理逻辑。实际清理由主监督循环串行完成。

### 8. Gate 资产按平台分区，共享差分语义

现有 Windows Fixture 和报告不覆盖、不被 macOS 运行覆盖。新资产使用明确平台目录或文件名，例如：

```text
.codexhost/gate-a/macos/                 # 本地原始证据，忽略
 tests/fixtures/gate-a/macos/             # 可提交脱敏摘要
 docs/macOSCodex透明代理验证记录.md       # Gate 完成时
```

Probe/Gate Schema 提取共享字段，并使用平台判别联合承载 `windowsVersion`、`macosVersion`、bundle/package 身份等差异。现有 Windows Fixture 必须继续通过原 Schema 或经过明确迁移后通过，不允许自动覆盖 Golden。

官方 CLI 直连/Shim 差分继续复用当前场景和归一化规则。路径分隔、临时目录和 Unix 信号等平台差异只做最小、已评审归一化；未知差异默认失败。

### 9. 三层测试中只有真实 Gate 依赖本机 Codex Desktop

1. 共享 hermetic 测试：假 CLI 验证 argv/env、递归、任意字节、chunk、EOF、stderr、退出和大输出，在 Windows/macOS 普通检查中运行。
2. macOS hermetic integration tests：验证 App bundle Fixture 发现、进程身份、process group、信号、Crash、强制清理和无孤儿进程，不启动真实 Desktop。
3. 真实 macOS Gate：先执行官方 CLI 差分，再执行 Desktop 新建、继续、流式、工具、取消和应用/代理生命周期验证。

`npm run check` 只能运行前两类。真实 Gate 使用显式 macOS 命令，必须在用户正常关闭现有 Desktop 后运行。

### 10. Gate 结论必须按证据判定

`PASS` 要求安装和 CLI 身份、隔离环境继承、共享 Shim 透明性、官方 CLI 差分、真实 Desktop 功能及所有生命周期场景同时通过。`FAIL` 表示核心不变量已被证明不成立；`BLOCKED` 仅表示环境、权限或人工步骤使结论暂时无法得出。

macOS `PASS` 不替代 Windows 证据；共享代码改动还必须通过现有 Windows hermetic/差分契约。`FAIL` 或 `BLOCKED` 时保留 Probe 和诊断能力，但不得把跨平台 Gate A 标记为关闭，也不得继续把该 macOS 启动路径固化为生产事实。

## Risks / Trade-offs

- [LaunchServices 可能复用单实例或不把调用进程环境传给实际 App] → 在无现有实例时与直接 bundle 执行做对照 Capture；只采用能证明 PID 与环境归属的路径。
- [直接执行 bundle 主程序可能偏离正常 macOS 激活语义] → 验证菜单栏、窗口、Dock、URL/单实例和正常退出行为；若存在核心差异则不采用。
- [Electron Helper 或 CLI 后代可能创建新 process group、脱离直接父子树] → 同时记录 group 与后代快照，Launcher 作为外层监督者复核本次启动进程；无法可靠归属时 Gate 不通过。
- [SIGKILL 无法被 Shim 捕获] → 依靠预建 process group 和外层 Launcher 监督清理；测试 Shim 强制终止后 CLI 及后代是否仍能收敛。
- [macOS 原生进程 API 需要少量 unsafe 或新依赖] → 封装在 `platform` 的最小私有模块，优先使用成熟、固定版本的安全封装，增加 Clippy、单元和故障测试，不让原生句柄穿过领域边界。
- [重构共享 Shim 破坏已通过的 Windows 行为] → 先补齐现有行为的回归测试，再重构；Windows CI、Rust integration tests 和既有 Fixture 必须保持通过。
- [当前 arm64 证据被误当成所有 macOS 架构结论] → 报告明确记录架构；不声明未实测架构已通过，也不建立版本白名单。
- [Probe 捕获泄露本地路径、环境或会话] → allowlist、平台分区的忽略目录、确定性脱敏和人工复核；不捕获真实 Prompt、Transcript、Tool 输出或完整环境。
- [官方 CLI 差分需要认证并可能产生远端调用] → 非 live 场景使用隔离配置；live 场景使用专用测试 Prompt、最小权限和本地忽略的原始结果，只提交布尔摘要。

## Migration Plan

1. 在不启动真实 Desktop 的情况下，补齐共享 Shim 和当前 Windows 行为的回归测试，并把 Gate Schema/目录改造成平台分区结构。
2. 重构进程监督接口，使 Windows 继续走 Job Object，macOS 能在 spawn 前建立 process group；每一步保持 `npm run check` 和 Windows测试通过。
3. 实现只读 macOS App bundle、CLI 和进程发现，使用可控 bundle Fixture 完成 hermetic 测试。
4. 在用户正常关闭现有 Codex Desktop 后，依次执行 LaunchServices 与直接 bundle 可执行文件的隔离 Capture，选择并记录生产候选启动路径。
5. 运行 macOS 官方 CLI 直连/Shim差分、真实 Desktop 功能和生命周期 Gate，生成脱敏 Fixture 与 `PASS`、`FAIL` 或 `BLOCKED` 报告。
6. Gate 为 `PASS` 时保留 Rust 原生能力供后续正式 Launcher/Shim 使用；Gate-only Capture 和报告入口继续保持显式、默认关闭。
7. 若 Gate 失败，回滚未被测试证明安全的启动策略，但保留不改变 Windows 行为的共享测试、只读发现和脱敏诊断；返回产品/架构层决策，不使用全局环境或修改 App 绕过。

## Implementation Evidence Update

- LaunchServices `open -n -W --env` 已证明可创建全新 Desktop、传递本次进程级 `CODEX_CLI_PATH`、提供可等待句柄并形成独立 Desktop process group，因此成为唯一生产候选路径。
- direct executable 已证明环境继承、完整主窗口、Dock/菜单、已有实例拒绝、正常退出和错误传播，但继承调用者 process group，生命周期隔离弱于 LaunchServices，因此只保留为对照。
- 真实调用链已确认为 `Desktop → codexhost-shim → App bundle 官方 CLI`；官方 CLI 直连/Shim 的10个非 live/live场景全部相等，未知差异为空。
- hermetic与真实生命周期证据覆盖POSIX信号、Crash、Shim/Desktop强制终止、逃逸后代清理和无孤儿进程。Desktop正常退出时Shim收到`SIGTERM`并将官方CLI收敛为signal 15。
- 自动化宿主的Accessibility权限曾阻塞UI输入；最终改用用户人工操作、Gate只读监控的方式，在同一受监督LaunchServices实例和专用Thread中完成新建、流式回复、只读Tool、继续、取消、重新进入已有Thread继续以及正常退出。可提交证据只保留版本和布尔结果。
- 当前记录版本的macOS Gate A证据完整，结论为`PASS`。这只验证官方Codex CLI透明代理，不表示Pi RPC、Protocol Core或PiAdapter已实现。
- Gate专用Rust Probe、Capture Shim和Fake CLI已从正式Launcher/Shim源码迁入`tools/gate-a/native`或测试Fixture。正式Launcher只保留产品入口，正式Shim不包含Capture实现；Feature-gated Gate Shim通过`ProxyObserver`复用同一`run_proxy_with_observer()`核心，不复制透明代理。

## Remaining Questions

- 当前签名和bundle身份校验应在生产发现中作为硬失败条件还是受限诊断条件？本次Gate只确认当前安装身份一致。
- arm64 Gate通过后，是否需要在公开发布前增加x86_64或universal App的独立分发验证？该问题不影响本次arm64 Gate判定。
- Windows共享监督重构后的Job Object运行时回归仍需Windows CI或实机完成；macOS `PASS`不能替代该平台证据。
