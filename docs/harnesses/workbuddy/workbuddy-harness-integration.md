# WorkBuddy native Harness plugin

WorkBuddy 作为独立的 `workbuddy` Harness 运行 WorkBuddy AI 随应用分发的原生 CLI。插件选择 CLI 公开的标准 ACP stdio 接口，而不是控制 WorkBuddy Desktop、模拟它的私有身份，或把独立 CodeBuddy 安装重命名为 WorkBuddy。

## 接口选择与已确认版本

本集成在 macOS 上检查了 **WorkBuddy AI 5.5.2**。应用内置 CLI 的包版本为 **CodeBuddy 2.137.1**，路径为：

```text
/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

内置 `product.json` 将产品、认证端点和应用数据目录配置为 WorkBuddy；内部 CLI 入口仍名为 `codebuddy`，不表示它应被发现为独立的 `codebuddy` Harness。插件自动发现应用与其同一安装目录中的内置 CLI，不回退到 PATH 中的独立 CodeBuddy：

- macOS：依次检查 `/Applications`、`~/Applications` 下的 `WorkBuddy AI.app` 和 `WorkBuddy.app`，使用 `Contents/MacOS/Electron` 与 `Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`。
- Windows：检查 PATH 及 `%LOCALAPPDATA%/Programs`、`%ProgramFiles%` 下的 `WorkBuddy AI`、`WorkBuddy`、`WorkBuddyAI`，匹配 `WorkBuddy AI.exe`、`WorkBuddy.exe` 或新版安装器使用的 `WorkBuddyAI.exe`，并配对同目录 `resources/app.asar.unpacked/cli/bin/codebuddy`；不混用不同安装的可执行文件与 CLI。用户标准安装根依据[官方常见问题](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/FAQ)。路径发现和启动参数已通过模拟 Windows 文件布局测试。
- Linux：官方当前[平台说明](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/FQA)列出 macOS 和 Windows；没有已确认的 Linux App 安装布局，插件不猜测自动发现路径。

标准布局下只需安装 WorkBuddy App，不需要另外全局安装 CLI，也不要求 App 窗口保持运行；应用内部打包路径并非 WorkBuddy 对外承诺的稳定接口。`CODEXHOST_WORKBUDDY_COMMAND` 支持应用安装目录，也可显式选择支持 `--acp` 的原生 CLI，或 Windows `WorkBuddy.exe` / `WorkBuddy AI.exe` / `WorkBuddyAI.exe`、macOS WorkBuddy 应用内的 `Contents/MacOS/Electron`。明确指定 Desktop 入口时仍校验并使用同安装目录的内置 CLI，缺失时检查失败，不把 EXE 当裸 CLI 启动，也不静默换用其他安装。

连接设置页的本地 WorkBuddy 右侧详情卡片填写应用安装目录，例如 `D:\program\WorkBuddy`，无需填写 `.exe` 或脚本。Adapter 自动校验该目录内的应用与内置脚本；目录不完整时不回退到其他安装。支持保存和清除；设置优先于命令环境变量，清除后恢复环境变量或自动发现。路径保存在 Host 数据目录，重启 codexhost 后应用，不切换运行中的 Session。详见[自定义启动路径设置](../../architecture/harness-plugin-runtime.md#自定义启动路径设置)。

WorkBuddy 的[快速开始](https://www.workbuddy.ai/docs/workbuddy/Quickstart)描述产品安装与登录，[官方 ACP 文档](https://www.workbuddy.ai/docs/zh/cli/acp)明确以 `codebuddy --acp` 启动协议服务。CLI 的 ACP `initialize` 已在无提示、无模型请求的探测中成功，并声明 Session load 与委派相关能力；配置、取消、权限和问题流程也存在于该 CLI 的公开 ACP 接口与文档中。因此选择：

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron" \
  "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy" \
  --acp
```

这是 macOS 应用内置入口的实际启动形态；显式原生 CLI 覆盖直接追加公开的 `--acp` 参数；显式 Desktop 入口沿用上述运行时与脚本配对。每个可写 Host Session 拥有一个 stdio ACP 子进程。普通 Prompt 不进入 Shell 参数，Host 只通过 ACP 请求发送内容。

## 认证与数据隔离

直接运行内置 CLI 时，其内部默认值可能回退到 `~/.codebuddy`。插件不会沿用这一跨产品默认值：它只把 `WORKBUDDY_CONFIG_DIR` 视为用户选择；没有该值时使用 `~/.workbuddy-ai`，随后强制传给子进程的 `WORKBUDDY_CONFIG_DIR` 与 `CODEBUDDY_CONFIG_DIR` 指向同一 WorkBuddy 根。这样即使普通 CodeBuddy 配置了自己的 `CODEBUDDY_CONFIG_DIR`，WorkBuddy 的历史、认证和设置也不会泄漏到该目录。WorkBuddy CLI 负责认证、原生设置、工具和 MCP 配置；codexhost 不保存、复制或推断其凭据。

只完成 `initialize` 后进行的无 Prompt `session/new` 探测返回了 `Authentication required`。CodexHost 不读取或复制 WorkBuddy Desktop 的私有登录态，因此不能依赖 GUI 登录一定可供独立 ACP 进程使用。若 ACP 要求认证，应在 Host 外启动相同产品配置和数据根的内置 TUI，然后执行官方 [`/login`](https://cloud.tencent.com/document/product/1831/137046)：

```sh
CODEBUDDY_CONFIG_DIR="$HOME/.workbuddy-ai" \
WORKBUDDY_CONFIG_DIR="$HOME/.workbuddy-ai" \
ELECTRON_RUN_AS_NODE=1 \
"/Applications/WorkBuddy AI.app/Contents/MacOS/Electron" \
"/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
```

进入 TUI 后输入 `/login`，完成浏览器认证再重试 Harness。这里使用的仍是 App 内置 CLI，不表示需要另装一个 CLI。不要使用 Desktop owner runtime 的凭据，也不要发明 `codebuddy auth login` 命令。

## 工作目录与原生历史定位

Session 的执行工作目录始终来自 Codex Desktop 传入的 `cwd`，包括 Desktop 选择的 worktree；配置根 `~/.workbuddy-ai` 只是原生状态目录，不替代执行目录。历史文件使用 WorkBuddy 内置 CLI 的 `PathUtils.canonicalizeStorePath` / `compressPath` 规则：先解析工作目录的真实路径，再将 `/`、`\`、`:` 转为连字符、去除首尾连字符并合并连续连字符，保留大小写、点号、空格、下划线及 Unicode 字符。

WorkBuddy Profile 声明该目录编码；历史读取、跨目录 Fork 的临时桥接和派生 locator 校验均使用同一规则。普通会话仍拒绝只存在于其他项目目录的文件，并逐条验证历史中的 cwd 和 Session 身份；不以全局搜索结果或跳过归属校验来容错。此规则来自原生文件存储实现，不是 ACP 承诺的存储协议，升级时应以原生目录样本回归验证。测试使用独立目录样本覆盖首条 Turn、恢复、路径别名、跨目录 Fork 和错误归属，避免用被测路径函数生成全部输入。

## 动态产品快照与模型目录

WorkBuddy App 会把账号、版本和服务可用性共同解析出的产品快照交给其 Hosted CLI。小快照使用 `ACC_PRODUCT_CONFIG_V3`，较大的快照原子写入 WorkBuddy 配置根下的 `cache/acc-product-config-v3.json`，再通过 `ACC_PRODUCT_CONFIG_PATH` 传给子进程。若没有这份上下文，内置 CLI 会回退到随安装包发布的 `product.json`；WorkBuddy AI 5.5.2 内置的默认 `cli` Agent 在该回退配置中只暴露 Fast、Balanced、Primary 和 Deep。

对于自动发现或显式 Desktop 入口配对的内置 CLI，插件会沿用现有的 WorkBuddy 产品快照文件。调用方没有显式设置路径或任一内联产品配置环境变量时，插件检查 WorkBuddy 根目录及其 `cache` 均为非符号链接目录、快照为非符号链接且非空的普通文件，再传递 `ACC_PRODUCT_CONFIG_PATH`。POSIX 平台还校验当前用户所有权、目录不可由其他用户写入、文件不可由组或其他用户读取；Windows 文件隔离依赖原生目录 ACL，插件不以 POSIX mode/uid 判断 ACL。快照缺失或校验失败时保留内置 CLI 的回退配置；显式指定独立 CLI 时不自动推断 WorkBuddy 私有缓存，但会保留调用方显式提供的产品配置环境。

macOS 保持 ACP 原生目录和选择行为，不从产品文件追加 Model。Windows 独立启动的 CLI 可能因无法继承 WorkBuddy App 进程内快照而得到不完整的 ACP 目录，因此插件在 Windows 上读取传给当前 CLI 的产品配置作为补偿：以 resolved snapshot 中 `agents[name="cli"].models` 为目录，只关联顶层 `models` 中对应项的 `id`、`name` 和非空 `credits`，不会把供内部 Agent 使用的全部顶层 Model 当作 CLI 目录。结果按原生 ID 与规范化显示名称去重并追加到 ACP Session 的 `configOptions`；ACP 已列出的模型保持在前。`credits` 只作为快照中的不透明倍率标签展示，空值不推断为免费。插件不会读取或投影认证、Endpoint、功能配置等其他快照内容。

WorkBuddy Windows ACP 配置接口允许把上述 CLI 目录中的 Model ID 设为 `currentValue`，即使该 ID 没有重复出现在 ACP option rows 中；因此只有 Windows WorkBuddy Profile 允许这条补偿选择路径。选择仍使用同一个原生 Model ID 并等待 ACP `currentValue` 确认；真正的模型请求、账号授权、服务可用性和计费由后续原生 Turn 决定，Host 不重写路由或模拟响应。`ACC_PRODUCT_CONFIG_PATH` 是 WorkBuddy 第一方 App 到 Hosted CLI 的实际兼容机制，但不是 ACP 标准或已公开承诺稳定的 WorkBuddy API，因此升级 WorkBuddy 后需要通过原生边界测试复核。小于 WorkBuddy 内联阈值的快照只存在于 App 进程环境且旧缓存会被删除，独立启动的 CodexHost 无法自动取得，这种情况下使用内置 `product.json` 作为回退，只能得到安装包内置 CLI 目录，不能复现 App 当前的完整动态目录。

## Desktop 私有运行时边界

WorkBuddy Desktop 还包含面向官方应用的 owner runtime、签名身份、租约和 Session admission/grant 流程。这些不是第三方 Harness 的公共认证接口。本插件明确不会：

- 调用 `_codebuddy.ai/activateWorkbuddyOwnerRuntime` 或构造私有 admission、grant、签名和租约元数据；
- 接管或恢复 WorkBuddy Desktop 已存在的任务；
- 冒充 Desktop 以访问 Office 能力、连接器、官方自动化或其他 owner-only 服务；
- 将 Desktop 私有登录态复制到 ACP 子进程。

公开的 `_codebuddy.ai` ACP 扩展并不都属于 owner runtime。例如问题响应使用 CLI 支持的公开 interruption 扩展；扩展命名空间及其兼容规则以[官方 ACP 扩展参考](https://cloud.tencent.com/document/product/1831/137025)为依据。插件只调用已由公开 ACP 会话声明、且为当前 Harness 行为所必需的扩展。

## 能力边界

WorkBuddy 插件复用经过验证的 CodeBuddy ACP Session 语义，但保持独立身份、命令发现和原生数据目录。能力声明只覆盖公开 ACP 进程可以表达的行为：

| 能力 | 当前行为 |
| --- | --- |
| Inspect、Create、多个 Turn、可写 Resume | 已实现。创建和恢复使用 WorkBuddy ACP Session；恢复校验 Harness 身份、cwd 与原生 Session 身份。 |
| 流式文本、Reasoning 与工具 | 按 ACP 事件投影为公共 Item；工具调用、结果和原生权限请求保持同一调用身份。 |
| Cancel | 使用原生取消；取消后的连接恢复沿用 ACP Session 的进程重建与状态恢复约束，不能把仅收到取消回执当作新 Turn 已可用。 |
| Model、Thinking、Permission Mode | macOS 使用 ACP 原生 Model List；Windows 将 resolved snapshot 的 CLI Model 目录与 ACP 配置目录合并去重，并允许选择补充项，选择后等待 ACP `currentValue` 确认。Thinking 和 Permission Mode 仍只使用 ACP 原生选项。 |
| Question | 使用原生 interruption/question 流程映射到 Host Question；只调用公开会话支持的扩展。 |
| Usage | 读取原生模型请求用量。未实现账号总额度，也不把 credits 推断为美元。 |
| Native history | 从隔离的 WorkBuddy 原生历史读取当前父链，保留持久化用户消息 ID；缺失、歧义、损坏或不完整状态不会伪装成成功。 |
| Native subagents | 投影原生 Agent 子任务状态，并从同一 WorkBuddy 数据根读取受约束的只读子 Thread；派生 Session 会固定并复制已保留 Agent 结果引用的子 Transcript 前缀。这不等于获得 Desktop 私有任务或连接器。 |
| Slash commands | 暴露固定且可安全映射的 `/compact` 与 `/init`。命令目录在 Adapter 与 Session 之间保持一致；会切换 Session、脱离当前 Thread 或依赖原生 UI 的命令不通过 Host 暴露。 |
| Context compaction | `/compact` 交给原生 WorkBuddy 执行；只有原生历史持久化了成功的压缩记录才投影成功的 `contextCompaction` Item。自动压缩保留在触发它的原 Turn 内。 |
| Fork | 创建独立、可继续写入的 WorkBuddy Native Session，精确保留所选 checkpoint 及以前的完整 Turn。支持同目录和跨目录，来源 Session 不被修改。 |
| Revise previous message | 通过 `rollbackLastTurn` 创建独立、可写的新 Session，并精确移除一个完整的最后 Turn；源 Session 保持不变，Model、Thinking 和 Permission Mode 会继承或采用显式修订设置。 |
| Cross-Harness delegation | 普通持久化 WorkBuddy Thread 的委派 CLI 发现、凭据传递以及创建、读取、等待、继续、取消路径已接线；这与 WorkBuddy 自身的 Agent 子任务是两套独立能力。由于尚未完成已登录 WorkBuddy 的递归调用验收，README 暂不标记支持。 |
| Images | 当前公共 Turn 输入仍为文本；CLI 声明图像能力不等于 Host 已提供图片输入。 |

上述“已实现”表示 Adapter 的协议和公共契约路径已接线，不表示本轮完成了认证后的付费在线验收。尤其是 Model 目录、权限名称、历史格式和子 Agent 事件仍须在已登录的目标账号与实际 WorkBuddy 版本上复核；运行时以原生响应为准，不把 2.137.1 的观察结果硬编码为永久产品能力。

### Fork、跨目录 Fork 与修订边界

WorkBuddy 2.137.1 对标准 ACP `session/fork` 返回 `Method not found`，所以本集成不会虚构一个标准 ACP Fork。派生流程组合该版本公开 CLI 的 `--resume ... --fork-session` 管理模式、原生 `/fork` 和公开 `_codebuddy.ai/session/rollback` 扩展：先生成不调用模型的临时原生副本，再由目标目录中的 WorkBuddy ACP Session 执行原生 Fork，最后回滚到请求的精确 Turn 边界。所有模型工作仍由最终的 WorkBuddy Native Session 承担。

回滚通知已落盘不代表新进程已经恢复了分支指针：内置 CLI 的 `resend_edit` 会修改当前进程的 `lastMessageId`，但新进程 `session/load` 可能忽略 `resend-fork-notice`，重新选中被丢弃的分支末尾。因此，最终可写 Session 在加载后、接受 Prompt 前会检查已经校验的原生历史：最后一个消息／回滚记录若仍为回滚通知，就在该进程重新执行原生 rollback 并确认目标位置（空前缀为 `null`）。普通恢复和取消后的进程重建共用此路径。标题、摘要和文件快照不改变该判断；一旦已有新的消息、Reasoning 或工具记录接续分支，就不再回滚，保留后续有效对话。恢复失败时关闭 Session，不返回可写成功。此逻辑不增加持久化状态、不改写 Transcript，也不按操作系统分叉；已经错误续写的旧会话不自动修剪，应从正确 checkpoint 重新派生。

无模型复制阶段（`--print --fork-session`，stdin 直接 EOF）在自动发现的 App 内置 CLI 上默认设置 `DISABLE_TELEMETRY=1`，避免在复制前等待原生遥测通道初始化。该设置仅传给临时复制进程；调用方显式设置的同名环境变量保留，显式覆盖的自定义 CLI 不自动应用。正常 ACP、原生 `/fork`、rollback、源历史校验和临时副本删除流程保持原有语义；仍等待复制进程正常退出后再验证落盘结果。

原生 `session/load` 只在当前项目存储中按 Session ID 查找，不能直接跨项目加载来源 Session。跨目录 Fork 因此把上述原生临时副本的完整字节，以排他创建和仅当前用户可读写权限桥接到目标项目；目标 `/fork` 成功后，只在文件仍与适配器创建内容完全一致时删除这份桥接文件。原生 CLI 在来源项目创建的临时副本没有公开删除 API，可能保留在 WorkBuddy 数据目录中；适配器不会绕过原生所有权直接删除它。

`--fork-session` 和原生 `/fork` 都不会复制 `<sessionId>/subagents/*.jsonl`。对于保留前缀中的 Agent 结果，适配器按 `callId` 关联调用，通过结构化的 `subAgent.sessionId` 与包含式 `lastId` 确定子 Transcript 边界，再把精确前缀以排他创建和 `0600` 权限复制到最终 Session。它不会依赖跨 Session 全局扫描到来源 sidecar；来源删除后派生 Session 仍可独立读取。源文件、目标文件、内部 Session 身份、字节数、行数、SHA-256 与历史 cwd 均被复验，符号链接、歧义、越界范围、并发变化或非精确的已存在目标会使派生失败。桥接清理和子 Transcript 复制的 POSIX 权限位检查仅用于 POSIX 平台；Windows 依赖原生目录 ACL，不用合成的 mode 位判断隔离性，路径、文件类型和内容校验仍然保留。

最终 Native Ref 记录目标 cwd、目标项目 slug、继承主历史前缀，以及每个继承子 Transcript 的 provenance 和原生目标绑定记录。Resume 和后续历史读取都会重新验证这些约束；继承前缀变化、派生后的追加内容来自其他 cwd、来源在派生期间变化、checkpoint 不存在或原生回滚未精确落盘时，操作失败关闭而不是返回近似 Session。工具历史继续使用其原始 cwd 投影，因此跨目录 Fork 不会把旧命令伪装成在目标目录执行。

### 跨 Harness 委派与原生子 Agent

普通非临时 WorkBuddy ACP 进程仅在 CodexHost 已提供完整的 `CODEXHOST_CLI_PATH`、`CODEXHOST_RUNTIME_ENDPOINT`、`CODEXHOST_RUNTIME_TOKEN` 和 `CODEXHOST_THREAD_ID` 时，通过公开 `--append-system-prompt` 获得固定的 CLI 发现说明。敏感值只保留在子进程环境中，不进入参数或 Prompt 文本。WorkBuddy 调用现有 CodexHost 委派协调器后，子任务仍是普通、持久化、可恢复的 Harness Thread；Host 没有 WorkBuddy 专用委派分支。

WorkBuddy 原生 Agent 工具创建的是同一 Native Session 体系内的子 Agent，Adapter 只读投影它们的状态和 Transcript。它们不是 CodexHost 跨 Harness Thread，也不会自动获得其他 Harness 的身份或能力。

## 插件、路由与发行

插件源码位于 `packages/adapters/workbuddy`，Manifest、Adapter、Session 和 Native Ref 都使用 `workbuddy` 身份。新 Thread 使用共享 `encodeHarnessPluginRoute` 路由，不新增 WorkBuddy 专用 Host codec 或回退分支。

插件通过 `scripts/release/harness-plugins.json` 预装。构建产物只包含 Adapter Bundle、Manifest 和资源，不包含 WorkBuddy AI 应用、CLI 二进制或登录态。macOS 用户安装 WorkBuddy AI App 即获得本集成使用的内置 CLI，但仍须按需完成该 CLI 配置根的首次认证；独立插件根目录也可通过自己的 `enabled.json` 显式启用，但不能与同 ID 的预装副本同时存在。

受管 macOS Remote/SSH Host 与 CodeBuddy 一样必须先在目标 Mac 的 Aqua 登录会话安装并检查 Broker；插件不会退回 SSH 后台进程：

```sh
codexhost broker install --harness workbuddy
codexhost broker status --harness workbuddy
```

本集成的产品身份不改变原生所有权：WorkBuddy 认证、数据保留、网络访问和计费仍由 WorkBuddy CLI 负责，codexhost 负责 Thread 映射、公共事件投影和插件生命周期。

## 验证状态

初始接入完成了以下无模型请求探测：

- 读取 WorkBuddy AI 5.5.2 内置产品元数据及 CodeBuddy 2.137.1 CLI 包版本；
- 通过内置 CLI 启动 `--acp` 并成功完成 `initialize`；
- 确认本机独立 ACP `session/new` 返回认证要求，集成不依赖 Desktop 私有登录态；
- 确认标准 ACP `session/fork` 不存在，并核对公开 CLI Fork、原生 `/fork` 与 rollback 扩展；
- 核对公开 ACP 能力与私有 owner runtime/admission 的边界。

2026-09-18 在本机 macOS 的 WorkBuddy App 内置 CLI 上，以现有原生认证和 Auto 模型完成了真实 create → 空历史读取 → 首条 Turn → close → 同 Session resume → 第二条 Turn → 两轮历史读取。执行目录包含大小写、点号、中文和空格；两个 Turn 都成功，没有请求工具或文件修改。另验证了真实跨目录 Fork 到第一轮：派生会话恰好保留一轮，源会话仍保留两轮，派生会话关闭后可在目标 cwd 恢复。此前失败任务的原生空历史也已通过修正后的只读目录校验。

2026-09-18 的性能复测确认，无模型复制阶段跳过遥测通道等待后，本机两轮历史的 Fork 从约 6.7–7.5 秒降至 5.3–5.6 秒；精确保留前缀、修订及关闭后恢复通过。但历史 Fork 恢复后继续对话报 `Could not identify exactly one persisted Native Turn`，关闭该优化的对照路径同样复现。其根因是管理进程中的回滚指针未在最终可写进程加载后恢复，而不仅是历史显示或遥测问题；当前实现按上述规则恢复尚未接续的分支指针。

修复后的 Windows WorkBuddy 5.5.6（内置 CLI 2.137.1、Auto）通过真实 Adapter 验证了中间／末尾 checkpoint Fork、跨目录 Fork、修订最后一轮、单轮修订为空，以及首次 Prompt 前关闭恢复和续写后再次恢复。验收同时检查新增消息父节点、Turn 数量、终态身份、模型可见的保留／排除标记及源历史字节不变，而不只检查打开成功。取消后继续对话和递归 Fork 的首条续写也通过；但“取消 → 继续 → 递归 Fork → 关闭恢复原分支”的组合出现回复已落盘、Host Turn 仍未在 60 秒内结束的情况，该组合仍待定位，不宣称所有组合已稳定。修复后的 macOS 在线路径尚未复测。

危险权限、真实跨 Harness 委派、压缩及子 Agent 的在线行为尚未在本轮验收。Fork、修订、命令、委派、Adapter、插件加载、发行 Bundle、Host 路由和 Desktop 的自动化验证使用受控 fixture；实际结果以对应验证报告为准，不能由本文替代。
