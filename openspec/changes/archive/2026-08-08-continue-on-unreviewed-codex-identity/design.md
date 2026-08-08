## Context

当前主进程标题策略通过 `connect-app-host listener → getContextForWebContents → WindowContext.createAppHost → services.threadMetadataGeneration → generateTitle` 定位并包装官方标题服务。实现同时检查必要结构和压缩后的 `constructor.name` 白名单；Codex Desktop `26.803.41515` 仅把标题服务类名改为 `nxe`，其余服务路径、prototype 方法、函数结构标记、窗口归属、Draft Prewarm 和 Model-state Adapter 均保持兼容，但旧白名单仍导致 Controller 在输出 `ready` 前退出，Launcher 只能报告空 readiness 并关闭 Desktop。

PRD 禁止因未知 Desktop 版本号本身建立白名单或版本门禁，但允许私有结构无法安全绑定时 fail closed。本设计不按版本号放行，也不接受用户覆盖必要结构失败；它只把压缩身份从必要结构中分离，并在必要结构已经通过时把未评审身份降为启动 warning。

## Goals / Non-Goals

**Goals:**

- 必要标题结构通过、仅压缩类名未评审时继续安装完整标题策略和生产 Renderer。
- 用严格、脱敏的结构化 readiness 把 warning 从 Controller 传给 Launcher。
- 在受管链路 ready 后向用户说明新 Codex build 尚未完整验证，并提供继续、固定 Releases 页面和原版 Codex三个操作。
- 用户确认继续后按 Desktop/codexhost 指纹抑制同一 warning 的重复提示；运行时仍每次执行必要结构检查。
- 保持 Prompt、Transcript、Model 值、Thread/Request ID 和用户路径不进入 warning、缓存或 GitHub URL。

**Non-Goals:**

- 自动下载、安装或回滚 codexhost。
- 维护 Codex Desktop 版本白名单、兼容矩阵或远程兼容服务。
- 允许用户强制覆盖必要结构、唯一性、ownership、Model-state 或 Host bridge 失败。
- 扩展标题服务之外的私有结构 warning 分类。
- 修改 Codex Desktop、ASAR、Host 路由或 Harness 行为。

## Decisions

### 1. 必要结构与已评审身份分开分类

标题服务探测返回有界事实，而不是在一个复合 `if` 中统一抛出签名错误：

```text
必要结构：
service path存在
→ service prototype存在
→ generateTitle为prototype函数
→ 函数体包含已评审标题失败标记
→ createAppHost与Renderer ownership可安装

已评审身份：
constructor.name ∈ reviewed names
```

必要结构任一失败仍使用现有错误/fail-closed 路径。必要结构全部通过但类名未知时，策略照常包装 `generateTitle`、建立 ownership、完成 Renderer reload/readiness，并附带 `unreviewed-title-service-identity` warning。类名不再单独授权服务；服务路径和结构才是继续安装的前提。

替代方案：删除类名检查。拒绝，因为会失去新 build 的可见诊断信号。替代方案：任何未知类名继续阻断。拒绝，因为压缩标识变化已证明会产生无功能语义变化的高频误阻断。

### 2. Controller readiness 使用严格单行 JSON

Launcher 与随包 Controller 使用同版本、原子发布，因此把当前 `ready\n` 升级为一个有界单行 JSON 协议：

```json
{"schemaVersion":1,"state":"ready","warnings":[]}
```

warning 只包含枚举 `capability/reason` 和有界 `observedIdentity`。Controller 启动异常仍写 stderr 并以 EOF/非零退出表达，不把任意 Error message塞进 readiness。Launcher 严格拒绝未知字段、未知枚举、超长值、多行或 malformed JSON。

Attachment Server 的 `ready/rejected/failed` 协议不变，因为它服务已发布运行实例，不承载首次启动 warning。

替代方案：继续使用 stderr 文本并由 Launcher 匹配字符串。拒绝，因为字符串解析脆弱，无法区分产品 warning 与技术错误。

### 3. warning 不阻断 Controller 安装，Launcher 在发布运行状态前提示

Controller 只有在 Title Policy、ownership、Draft Prewarm Policy 和生产 Renderer Adapter 全部 ready 后才能返回 `state=ready`。warning 因而表示“必要链路已工作但身份尚未评审”，不是“带缺失策略继续”。

Launcher 收到 warning 后先检查本地确认记录：

- 同一指纹已确认：继续发布 Runtime Descriptor并 detach，不重复提示。
- 未确认：显示原生信息提示。
- 选择继续或打开 Releases：记录确认，保持当前受管 Desktop，随后发布描述符并 detach。
- 选择原版 Codex：不发布描述符，关闭 Controller与受管 Desktop，等待 Shim/Host清理，再通过官方安装身份启动不带 codexhost环境的原版 Codex。

打开 Releases 不关闭当前 Desktop，避免用户被迫中断工作。提示使用信息样式，不使用崩溃、严重错误或“强制启动”措辞。

### 4. 确认记录按完整本地指纹失效

Launcher在平台应用数据目录保存严格、原子、无符号链接的确认记录。键至少包含：

```text
Desktop identity
Desktop version
bundle/package build
official ASAR integrity SHA-256
codexhost version
warning capability + reason + observed identity
```

记录只优化提示频率，不能跳过 Controller 的每次必要结构检查。任一字段变化、记录损坏、Schema未知或文件类型不安全时视为未确认并重新提示。记录不构成版本兼容矩阵，也不上传。

### 5. 用户操作使用固定平台能力

- `获取最新版` 只打开 `https://github.com/BytePioneer-AI/codex-host/releases/latest`，不接受 Controller、Renderer、warning或用户提供的 URL。
- `使用原版 Codex` 复用已发现并验证的官方 Desktop identity，不按进程名或可写路径猜测。
- Windows复用 `TaskDialogIndirect` 信息样式；macOS增加等价 `NSAlert`。平台 API 不可用时，Launcher在 stderr输出同一脱敏摘要并默认继续已通过必要检查的 codexhost链路，不把 UI 故障解释为结构不兼容。

### 6. 兼容详情保持脱敏且可定位

提示正文显示 Codex Desktop version、codexhost version、能力中文名和原因摘要；技术日志额外记录稳定 reason code、reviewed identity集合和 observed identity。不得记录函数源码、完整 ASAR 路径、用户目录或运行时业务数据。

本次不自动创建 GitHub Issue，也不把诊断拼接到 URL；后续如需预填 issue，必须另行评审字段和长度。

## Risks / Trade-offs

- [未知类名对应了语义变化但必要结构仍碰巧匹配] → 保留精确服务路径、prototype方法、函数结构和ownership检查；warning只覆盖类名，不覆盖任何必要检查，并要求后续受控 Gate评审新身份。
- [用户误认为 warning 等于完整兼容认证] → 文案明确“核心检查已通过、尚未完成完整验证”，不使用“完全兼容”。
- [确认缓存掩盖后续运行时变化] → 缓存只抑制提示，Controller每次启动仍执行全部必要结构和安装 readiness。
- [原版 Codex启动时仍继承 Shim环境] → Launcher先结束受管链路，再用平台官方启动入口构造干净环境，并增加进程级测试。
- [Launcher/Controller readiness升级造成混用] → 两者随发布Payload原子升级；严格Schema失败保持技术错误，不猜测旧文本。
- [macOS原生提示增加平台实现成本] → 只实现一个信息提示和三个固定Choice，不引入GUI框架。

## Migration Plan

1. 增加标题结构事实与 warning分类，不改变已评审类名的正常路径。
2. 升级 Controller/Launcher内部 readiness协议并同步测试和发布Bundle。
3. 增加本地指纹确认存储及失效测试。
4. 增加Windows/macOS原生提示、固定 Releases URL和原版Codex启动路径。
5. 使用合成未知类名验证 warning继续链路，再在真实 Desktop build验证 ready、提示、三个操作和无敏感诊断。

回滚时恢复未知类名 fail-closed、纯 `ready` readiness和现有错误行为；删除确认记录不是必要迁移，旧文件可由无消费者状态自然保留或在后续清理。

## Open Questions

- Windows安装包中用于确认记录的官方 ASAR integrity来源需要在实现前从当前Package布局取证；若官方元数据不提供可信摘要，应使用已验证资源文件的SHA-256，而不是仅依赖版本号。
