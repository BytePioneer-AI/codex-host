# Herdr Core 终端后台调研与候选接入方案

> **状态：暂缓实施。** 本文仅保存背景、证据、候选设计和验证门槛，不表示已决定迁移，也不表示 codexhost 已支持 Herdr Core。本次记录不包含原型开发、安装、打包、服务启动或运行中终端迁移。
>
> 调研日期：2026-11-01。现有终端实现以提交 `33e2b28f2` 为核对基线；Herdr、Herdr Core 和 Herdr App 的源码基线见第 12 节。上游协议、产品发布状态和网站文案可能变化，恢复评估时需要重新核对。

## 1. 摘要

候选方向是：**Herdr Core 负责终端进程与屏幕状态，Host 负责终端归属和访问控制，现有 Web 页面负责显示和输入。**

这是一项终端后台替换，不是移动端界面迁移，也不是 Harness 执行方式迁移。Herdr Core 不提供可直接迁入网页的输入框；即使采用它，xterm.js、手机原生 DOM 文本框以及浏览器输入法适配仍然需要保留。

现阶段的判断：

- Herdr Core 提供独立终端服务及公开客户端协议，有实际接入路径，值得作为减少 PTY 和终端后台维护的候选。
- Alma 的公开产品说明证实了“Herdr 管终端，另一个客户端提供聊天和终端界面”的产品切分，但没有提供可直接复用的 Alma Herdr 客户端源码。
- 当前 Core attach 协议没有与 codexhost 现有逐次输入确认等价的能力；不能把输出流控或写入 socket 成功解释为输入已被后台接受。
- codexhost 现有 Host 监管器会清理受管子进程树。若要让终端跨 Host 重启存活，Core 不能只是挂在该进程树里的普通子进程。
- 是否确实减少维护成本，取决于协议适配、进程监管、打包和故障恢复的验证结果，不能仅凭项目知名度或原生客户端的演示认定。

**当前决定只有“先不实施，保留研究材料”。以下推荐默认值、包边界和生命周期行为均是候选，不是已生效的契约。**

## 2. 背景与问题边界

### 2.1 为什么评估这个方向

Web 右侧栏需要日常可用的终端：桌面直接输入，手机支持中文选词、英文联想、粘贴、回车、Tab 和中断等操作。维护压力来自不同层次：

1. **浏览器输入层**：软键盘与组合输入事件、草稿、提交动作、键盘遮挡及触摸控制。
2. **终端显示层**：解析终端转义序列、绘制屏幕、处理终端模式。
3. **终端后台层**：启动 Shell、PTY 读写、进程归属、输出恢复、连接控制、配额和清理。
4. **产品接入层**：Web 认证、会话归属、工作目录、标签和权限边界。

手机输入丢字与终端后台的生命周期不是同一个问题。升级数据传输或替换后台不自动解决输入法事件问题；把文字先交给原生文本框编辑，也不解决 Web 服务重启时终端进程结束的问题。

Herdr Core 的主要评估目标是第三层：降低终端后台维护成本，并让界面重启与终端进程存活解耦。第一层仍需单独验收。

### 2.2 与 tmux 的关系

可以把 Herdr Core 理解为“可通过程序接口连接、具有类似 tmux 后台职责的终端服务”，但它不是 tmux 插件，也不完全等同于 tmux。

| 维度 | tmux | Herdr Core |
| --- | --- | --- |
| 保持终端进程 | 支持 detach 后继续运行 | 支持客户端断开后继续运行 |
| 重新连接 | attach 到 session/window/pane | 通过终端地址与 attach 流重新连接 |
| 界面和布局 | 自带终端内的窗口、分屏与快捷键交互 | Core 不画界面，客户端自行呈现 |
| 程序接入 | CLI、脚本、control mode 等 | CLI、JSON-RPC、framed attach 流和事件 |
| Agent 状态 | 通常需要额外集成 | 保存程序通过 OSC 7501 主动报告的状态，不通过画面猜测 |

“终端继续运行”以相应后台和进程仍然存活为前提；不能据此承诺电脑重启后恢复原进程或自动恢复 Harness 的原生任务。

## 3. codexhost 当前实现

### 3.1 当前不是从零实现终端引擎

```text
Browser
  xterm.js + mobile textarea + control keys
      |
      v
Web service
  authenticated mux + DSH terminal controller
      |
      v
DSH subprocess provider + node-pty
      |
      v
Shell / command process
```

| 层次 | 当前实现 | 主要代码入口 |
| --- | --- | --- |
| 终端显示 | xterm.js，桌面继续使用其键盘路径 | [terminal.tsx](../../apps/web-ui/packages/client/ui-sidebar-terminal/src/client/terminal.tsx) |
| 手机输入 | 可见原生 textarea、两档 Enter、单行横滑控制键、有限高度自动增高 | [MobileTerminalComposer.tsx](../../apps/web-ui/packages/client/ui-sidebar-terminal/src/client/MobileTerminalComposer.tsx)、[mobile-terminal-submit.ts](../../apps/web-ui/packages/client/ui-sidebar-terminal/src/client/mobile-terminal-submit.ts) |
| 草稿与回执 | 按终端视图保存内存草稿，等待服务接受确认，不自动重放不确定输入 | [mobile-terminal-draft.ts](../../apps/web-ui/packages/client/ui-sidebar-terminal/src/client/mobile-terminal-draft.ts)、[终端客户端模型](../../apps/web-ui/packages/api/terminal-controller/src/client/model.ts) |
| 终端后台 | DSH 官方 `terminal/attach` 双向流，服务端 headless xterm 与屏幕序列化、控制权及保留策略 | [terminal.ts](../../apps/web-ui/packages/api/terminal-controller/src/terminal.ts)、[retention.ts](../../apps/web-ui/packages/api/terminal-controller/src/retention.ts) |
| Web 接入 | 认证后的 mux 上行、DSH 后端装配、本地会话适配 | [transport.ts](../../packages/web-server/src/transport.ts)、[dsh-web-services.ts](../../packages/web-server/src/dsh-web-services.ts)、[后端装配](../../apps/web-ui/packages/host/dsh-web-backend/src/index.ts) |
| 目录与身份 | 已登记本地草稿或 Thread 的目录；缺省时使用 Web 服务用户主目录 | [ch-sessions.ts](../../packages/web-server/src/ch-sessions.ts) 的 `terminalWorkspaceRoot()` |
| 发行 | 携带 node-pty 及 DSH 子进程 runner | [pack.ts](../../packages/web-server/scripts/pack.ts) |

当前行为以 [独立 Web 产品文档](../product/standalone-web.md#右侧栏) 为准。DSH 终端源码与协议迁入基线记录在 [import-manifest.json](../../apps/web-ui/import-manifest.json)，不是全面升级所有 DSH 插件。

### 3.2 需要保留的行为

- 手机中文选词、英文联想和本地退格只编辑草稿，不用字符串差异猜测远端光标。
- 输入法 Enter 可选“仅输入”或“发送并回车”；Shift+Enter 在草稿内换行。右侧发送箭头始终执行“输入并回车”。
- 文字经 xterm 的公开 paste 路径处理；有待提交文字时，后续回车或 Tab 等待前面的输入接受确认。
- 输入确认不等于命令执行成功。未收到完整确认时保留草稿，重连不自动重发；手工重发需要确认。
- 等待文字确认时，Ctrl+C 仍可中断，并取消尚未发送的后续回车或 Tab。
- 多行文字在没有 bracketed paste 支持时可能立即执行命令，不能把“仅输入”宣传为绝对不会执行。
- 输入控制权接管后，旧连接只读，不能继续输入或抢尺寸。
- 手机输入体验仍需真机验收；Chromium 设备模拟和真实 PTY 测试不能替代 iOS Safari、Android 输入法验证。

### 3.3 当前生命周期限制

DSH 后端运行在 Web 服务进程内。连接、组件和终端进程有各自生命周期，不能把单个输出连接断开等同于立即杀进程；后台也有保留与回收策略。但 **Web 服务退出会清理其拥有的终端进程**。

关闭终端标签是显式结束终端，不等同于隐藏侧栏。当前实现的设计背景见 [右侧栏恢复设计](../../openspec/changes/restore-web-right-sidebar/design.md)。

## 4. Herdr 项目的分层

| 项目 | 已核实定位 | 与本方案的关系 |
| --- | --- | --- |
| [herdr](https://github.com/herdrdev/herdr) | Rust 编写的终端工作区管理器，包含终端内管理界面和后台能力；核对版本为 `0.9.5` | 用于理解既有产品及旧协议，不作为与 Core 等价的接口 |
| [herdr-core](https://github.com/herdrdev/herdr-core)，CLI 为 `hc` | 独立终端后台；README 明确说明 Core 不绘制界面，可由自己的应用连接 | 候选后台 |
| [herdr-app](https://github.com/herdrdev/herdr-app) | Rust／GPUI／Ghostty 相关原生桌面实现，连接 Core | 不是可直接导入 Web 的 React 组件，不在迁入范围 |
| [Alma](https://alma.now) | 提供 Herdr 客户端的桌面与 iOS 产品，可把支持的 Agent 会话呈现为聊天，也能切回终端 | 产品架构参考，不是终端后台依赖 |
| [alma-relay](https://github.com/yetone/alma-relay) | Alma Remote Access 的 HTTP、SSE、WebSocket 中继 | 不是 Herdr 客户端、PTY 后台或终端渲染器 |

Herdr、Core 和 App 的核对仓库声明 Apache-2.0；Alma Relay 的仓库声明 MIT。正式再分发仍需逐项核对所选版本的 LICENSE、NOTICE 和第三方依赖许可。开源后台的许可不等于 Alma 客户端源码已公开。

旧 Herdr TUI 与独立 Core 是不同接入目标，不能混用命令、socket 路径或协议。候选方案只面向 Core，不同时承诺兼容两套协议。

## 5. Alma 调研证据及其限度

### 5.1 官网直接核实的事实

2026-11-01 核对 [alma.now](https://alma.now)，其 Herdr 区域使用 “Herdr, built in” 标题，并明确写明 “Alma is a client for herdr”。页面描述：

- Claude Code、Codex、Pi 继续运行在终端中，Alma 将会话呈现为聊天。
- 可以回答问题、批准操作、发送后续消息，并随时切回终端。
- iPhone 页面展示手机宽度终端及 Esc、Ctrl+C、方向键。
- 手机远程访问可以经 Relay 或同一局域网连接桌面端。

这些事实支持“终端宿主与 GUI 客户端分离”的架构解释，不足以确定 Alma 使用了哪个终端渲染引擎、哪条 Core 接口或哪种输入法事件处理。

### 5.2 X 作者原帖索引

以下原帖由 Grok 的 X 搜索和线程读取返回；本文记录链接与检索结论，没有对每条 X 内容独立抓取或对发布包逐一验收。恢复评估时应复核原帖、后续回复与对应发布版本。

| 日期（2026，UTC） | 作者原帖 | 检索结论 |
| --- | --- | --- |
| 10-28 | [yetone：将 Herdr 客户端合并到 Alma iOS](https://x.com/yetone/status/2115516478254624914) | 作者称手机端集成了完整功能的 Herdr 客户端，最初只适配 Claude Code |
| 10-29 | [yetone：电脑 TUI、手机 GUI](https://x.com/yetone/status/2115660854725382156) | 强调保留电脑上的原生 Herdr TUI 操作方式，手机使用 GUI |
| 10-29 | [yetone：socket 发现路径](https://x.com/yetone/status/2115883948509388957) | 提到桌面客户端此前只识别特定 `herdr.sock` 路径，说明需要处理后台发现 |
| 10-30 07:06 | [yetone：旧 Herdr 与 Core 双适配](https://x.com/yetone/status/2116064188376502374) | 提到 Core 与旧 TUI 不兼容，并称客户端同时适配两者 |
| 10-30 08:18 | [yetone：Core 适配与发版状态](https://x.com/yetone/status/2116082228736426020) | 同日回复仍称 Core 在适配、等待发布；不能仅凭上一条判断某个安装包已支持 |
| 10-30 | [yetone：iPad、Codex、Pi](https://x.com/yetone/status/2116266362415075638) | 提到扩展设备和 Agent 支持，与官网所列产品方向相符 |
| 10-31 | [yetone：Relay 开源](https://x.com/yetone/status/2116599592930488707) | 指向公开的 Alma Relay 仓库 |

### 5.3 可以得出和不能得出的结论

可以得出：Alma 内置 Herdr 的客户端能力，支持把终端中的 Agent 会话呈现为更适合手机的 GUI；这是候选架构的产品先例。

不能据此断言：

- Alma 一定把完整 Herdr 或 Core 二进制随安装包分发；“内置客户端”不等于“内置后台”。
- 某一版本已经完整支持 Core；作者对适配与发版阶段的表述需要结合具体版本判断。
- Alma 使用 `hc connect` 或 `terminal.attach`；原帖没有证明具体线协议。
- Alma 的终端一定是原生渲染、WebView、Ghostty 或 xterm.js；公开材料未说明。
- Alma 已解决浏览器中文 IME。调研未发现对应实现或真机测试证据，桌面／iOS App 的效果不能替代 Web 浏览器验收。
- 可以直接复制 Alma 的 Herdr GUI。调研未找到这部分公开源码；不能因为 Relay 开源，就认为 GUI 和终端适配也开源。

[Alma Relay README](https://github.com/yetone/alma-relay#readme) 已独立核对，其职责是手机到桌面 Alma 的远程流量转发，不是把 Herdr 转成浏览器终端的现成组件。本方案不包含 Relay 部署；公网手机访问见[Web 远程访问](../product/web-remote-access.md)。

## 6. Herdr Core 原生契约：已确认的能力与差异

本节基于固定源码版本的 [API 说明][core-api]、[OpenRPC schema][core-schema] 和 [安全说明][core-security]，不是实际集成验收结论。

### 6.1 接口和输出流

| 能力 | 原生行为 | 接入含义 |
| --- | --- | --- |
| 连接 | Unix socket／Windows named pipe；`hc connect` 可通过 stdin/stdout 携带协议 | 先做本地接口适配，不需要暴露公网 Core 端口 |
| 握手 | `hello` 返回版本、协议 generation、Core 身份、methods/features；`framed: true` 切换模式 | 校验真实能力，不只检查可执行文件是否存在 |
| 启动 | `terminal.run` 支持程序参数、工作目录、环境和标签；也有 template、parent、远端等功能 | 只使用普通本地终端所需字段，不把整个自动化接口交给浏览器 |
| 连接终端 | `terminal.attach` 返回 channel，先发送屏幕重绘与可选历史，再发送输出；已由 Core 回答的终端查询会过滤 | 前端使用 Core 的重绘，不另维护第二份服务端 headless 屏幕 |
| 交互 | attach channel 支持 DATA、RESIZE、FOCUS、FACTS、CREDIT、CLOSE | 普通键盘走实时 attach 输入，不等价于自动化发送 RPC |
| 输出流控 | 初始 256 KiB credit；查看者为已消费字节返还 CREDIT；落后超过 4 MiB 时使用新重绘代替积压 | 浏览器、Web、Host 之间仍需有界队列，不能收到数据就无限补 credit |
| 多查看者 | 最后活动的可写查看者决定尺寸；`observe` 查看者不输入、不 resize | 与当前独占输入控制不同，需明确产品仲裁规则 |
| 事件 | 订阅返回快照，后续带序号；丢失事件收到 `missed`；序号随 Core 进程重新开始 | 重连需要重新取权威快照，不能跨进程沿用旧事件游标 |
| 稳定身份 | Core 有清空状态后才改变的随机 ID；终端有该 Core 内的稳定地址 | 关联记录必须同时保存 Core ID 和终端地址，不能只保存 `t7` |
| 进程保留 | holder 持有终端；计划重启可以由新 Core 接管进程 | 原生进程监管必须允许该原生生命周期，不得在 Core 重启时顺手清理 holder |

协议文档标注 **preview、generation 1、0.x**，同时规定已发布 API 的兼容性检查与显式 generation 变更规则。这不等于“每次更新都会破坏客户端”；风险在于仍需固定版本、握手检查与真实跨版本验证。

### 6.2 自动化发送不是普通键盘输入

`terminal.send` 的原生含义是粘贴文字并提交 Enter，遵循约三秒无人工输入的等待规则；还涉及程序状态、`force` 等自动化语义。`terminal.keys` 也遵循相应的输入空闲规则。

它们不能直接替代：

- 桌面逐键输入；
- 手机“仅输入、不追加回车”；
- 即时 Tab、方向键或 Ctrl+C；
- 等待文字确认期间取消尚未发送的回车。

候选方案应使用 attach 的原始输入通道。不要为取得 RPC 返回值而选用语义不同的方法，也不要修改 Core 自动化规则来伪装等价。

### 6.3 逐次输入确认是迁移门槛

现有 DSH 输入协议为 write/resize 编号，返回接受或拒绝确认。手机草稿清空及“文字后再发回车”的顺序依赖这个信号。

核对版本的 Core framed 协议没有对应的输入 ACK 帧；[viewer 输入实现][core-viewers] 接收字节后交给内部输入路径，没有向查看者返回同等确认。需要区分：

| 信号 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| Web 收到浏览器消息 | Web 收到了请求 | Core 已接受输入 |
| 本地 socket 写入完成 | 字节进入本地传输路径 | PTY 已收到、Shell 已处理 |
| 输出 CREDIT | 查看者归还输出容量 | 某次输入已被接受 |
| 终端回显 | 程序输出了某些内容 | 任意输入的可靠确认；密码或原始模式可能不回显 |
| 服务端真实输入接受回执 | 其契约定义的接受阶段已完成 | 命令执行完成或业务操作成功 |

推荐将“获得语义明确的原生确认，或经批准调整产品保证”列为转正条件。优先核验上游新增能力或推动上游提供相应契约，不默认维护长期 Core fork。

如果只能做到本地转发确认，必须重新设计草稿保留、重复提交和后续回车行为，并在产品说明中明确弱化之处。**在未作出该决定之前，不伪造当前的 `whenInputAcknowledged()` 保证，也不因重连自动重放输入。**

## 7. 候选架构与职责

### 7.1 推荐拓扑

```text
Browser UI
  xterm.js / mobile editor / tabs
      |
      v
Web Gateway
  authentication / browser streams
      |
      v
Shared Host terminal service
  ownership / access / writer arbitration / protocol adapter
      |
      v
Dedicated Herdr Core + holders
      |
      v
Shell / command processes

Native launcher manages Core lifecycle independently of Web/Host cleanup.
```

“独立”指 Core 和 holder 的存活不依赖某个 Web 或 Host Node 进程，不意味着脱离 codexhost 管理、无法停止或可以越过认证。

### 7.2 最小职责划分

| 所有者 | 候选职责 | 不承担 |
| --- | --- | --- |
| Rust 原生启动层 | 固定二进制发现、并发启动互斥、独立服务就绪与身份识别、停止和更新协调 | Harness 状态解释、Web 协议投影、会话权限业务 |
| Host 终端服务 | 终端归属、配额、操作校验、单写者仲裁、生命周期动作与 Core 连接 | 重建 PTY 实现、另写终端屏幕解析器 |
| 聚焦的 Core 客户端模块 | JSON-RPC、framed 通道、背压、事件和错误解码 | 通用终端引擎插件框架、旧 Herdr 双协议兼容 |
| Web Gateway | 现有登录认证、浏览器连接、经过授权的终端请求与输出转发 | 直接持有并公开 Core 的全量 API、成为进程所有者 |
| Web UI | xterm.js 渲染、手机输入、模式选择、草稿和错误展示 | 进程管理、服务端工作目录裁决 |
| Herdr Core | PTY、Shell、屏幕与历史、holder 及其原生恢复 | codexhost Thread 权限、Harness SDK 语义 |

具体模块路径在原型通过后确定。优先遵守现有公共导出与包边界，不为了两个临时后台实现建立永久通用插件层。Herdr Core 是终端基础设施，不注册成 Harness、Model 或 Provider。

当前终端 UI 的模型注入依赖 DSH `TerminalView`，因此“保持外观”不等于只改一个后台配置。需要替换数据源及必要的模型契约；不通过重新实现整个 DSH 后端来让 Core 看起来与它完全等价。

### 7.3 专用实例与最小权限

推荐每个明确的 Host 数据目录使用一套 codexhost 专用 Core 状态、配置和本地 endpoint：

- 不自动发现和接管用户日常运行的 Herdr/Core。
- 不仅设置 `HC_SESSION`。上游说明配置和 templates 可跨 session 共享，还应明确隔离配置、状态与 endpoint，并清理继承的相关环境变量。
- 普通终端创建显式指定经服务端校验的本地 cwd 和 Shell；不意外继承父终端、Agent template 或后台自动通知行为。
- 默认不启用远端 machine、自动化 Agent 调度、文件上传等无关能力。
- 对浏览器开放所需的最小操作，不接受任意 socket 路径、Core 方法、远端地址或未经校验的归属。

Core 以运行用户权限执行。Unix 目录权限或 Windows pipe ACL 是本地访问控制，不是额外 OS 用户隔离；同一用户下的进程仍属于 Core 的信任边界。session 名称和 labels 不能作为安全凭据。

## 8. 终端身份、恢复与产品行为

### 8.1 归属记录

候选关联是：

```text
codexhost local Session / terminal identity
    <--> Core identity / terminal address
```

需要满足：

- 对已登记的本地草稿和本地 Thread 创建终端，目录规则保持现状；缺省 home 不写回会话，不扩大文件树权限。
- 保存足以跨 Web／Host 重启恢复的终端归属；不复制 Harness Transcript，不把终端输出当成第二份 Thread 历史。
- 草稿转正式 Thread 时显式重绑定，已有进程不更换 cwd、不重新启动。
- 草稿目前包含 Web 内存状态，持久终端不能只依赖这一临时 map；草稿恢复与终端归属恢复必须一并验证。
- Core ID 改变、终端消失或归属无法确认时，显示不可恢复，不按同名 ID 自动接管另一个终端。
- `terminal.run` 返回超时可能已经创建进程；需要用预先登记的创建关联对照后台清单，无法判定时保留“结果未知”，不能立即重复创建。
- 已退出或已关闭的标签不因页面恢复而启动新命令；创建配额包含尚未明确结算的创建操作。

### 8.2 多连接与输入控制权

候选产品行为保持单写者：同一终端只有一个可写连接，其余只读。仲裁放在 Host，并在每次输入、resize、focus 或 display 更新时验证当前归属和控制权。

这项规则由 codexhost 提供，不描述为 Core 自带的独占锁。旧连接积压的输入和尺寸消息也必须在接管后失效。Host 重启期间不允许旧连接凭缓存状态继续写入；恢复后重新确认连接身份和控制权。

### 8.3 候选生命周期表

| 事件 | 建议行为 | 验证或限制 |
| --- | --- | --- |
| 隐藏侧栏、切换标签 | 不结束进程 | 输出订阅与进程分离 |
| 手机断网、页面刷新 | 重新 attach 到原终端 | 不重发未确认输入 |
| Web 重启 | Core 与终端继续运行 | 当前实现不具备此保证，是拟议变化 |
| Host 重启 | Core 与终端继续运行，Host 恢复管理连接 | 必须脱离当前 Host 监管器的清理树 |
| 显式关闭终端标签 | 结束对应终端，并处理失败重试 | 保留当前关闭含义，不静默改成 detach |
| 显式停止全部 codexhost 服务 | 结束专用 Core 和终端 | 纳入 `npm stop` 的可验证服务识别与清理，不碰用户其他 Core |
| Core 计划更新／重启 | 使用原生计划重启与接管语义 | `server.restart` 与 `server.stop` 不同，不能混用 |
| Core 异常退出 | 重连后报告真实进程与屏幕状态 | 部分状态可能为 `inexact`，不保证历史完整 |
| 电脑重启或程序确实丢失 | 明确显示丢失／结束，不自动重跑原命令 | 候选首版默认 `keep: false` |

Core 的 `keep` 会在适用的丢失情况下补建 Shell，不是恢复原程序。即使以后启用，也必须单独展示“新 Shell”，不能冒充原任务延续。

后台长期留存也不能等同于无限留存。终端数量、历史大小、无界面连接时的回收策略和显式清理入口需要确定；现有 DSH 保留策略不能未经比较就宣称与 Core 相同。

## 9. 原生监管、分发与升级

### 9.1 进程树是独立验证项

[host_service.rs](../../crates/launcher/src/host_service.rs) 在受管 Host 结束后执行后代进程清理。[stop.mjs](../../tools/dev-desktop/stop.mjs) 也依赖可识别的服务与监管关系。

不能仅靠 Node `detached` 标记就宣称 Core 会跨 Host 重启存活。需要验证：

- Core、holder、Shell 的实际父子关系和退出路径；
- Windows Job Object、Unix 进程组及独立服务注册行为；
- 计划 Core 重启时不会由外层监管器误杀 holder；
- Host/Web 崩溃后仍可识别专用实例，而不是留下无法管理的孤儿；
- 多个工作树或启动请求竞争时，只认领正确实例，不以 PID 单独判断身份。

### 9.2 发行包内置，而非运行时随意安装

如果原型通过，推荐随 codexhost 发行包携带固定的 Core 可执行文件：

- 按目标 OS/CPU 校验产物，核对下载来源、哈希、签名条件和许可文件。
- 不在用户第一次打开终端时执行未经管理的在线安装脚本。
- 不借用用户 PATH 中版本未知的 `hc` 作为生产默认值。
- 升级前校验协议 generation、方法与能力；发现不兼容时明确拒绝，不自动重置状态目录。
- 由 codexhost 发行节奏管理版本，不让 Core 自更新绕过已验证组合。
- 上游说明校验和依赖发布服务与 HTTPS，不能把“有 SHA-256”表述为独立签名验证。

构建工具链包含 Rust、Zig 等依赖；是否使用可验证的预构建产物或自行构建、各平台包体积和构建成本均未实测。

### 9.3 历史与隐私

Core 状态目录可能包含终端记录、屏幕、历史和日志，可能留有命令、路径或敏感输出。与 Web 进程内的临时状态相比，这是需要明确说明的持久化行为。

候选要求：仅当前用户可读、可明确清理、保留有上限、不在日志中默认复制全部输入输出。Core 不自动加密状态目录，不能把本机权限描述成端到端加密或磁盘加密。

## 10. 评估路线、迁移与回退

以下是恢复工作后的候选顺序，不是已经开始执行的任务。

### 阶段 A：隔离兼容性原型

使用固定版本和临时专用状态，不接管真实终端。首先验证两个否决项：输入确认语义、进程跨 Web／Host 重启存活。

再覆盖实时输出、重绘、组合输入、控制键、多连接尺寸、创建不确定结果、平台启动与停止。验证失败时先记录缺口和上游解决路径，不通过重放、伪造 ACK 或更换同义外观的 API 绕过。

### 阶段 B：新建终端的受控试用

保留现有 UI 外观，替换数据源与所需模型契约。仅让明确选择试用的新终端使用 Core。

- 已有 DSH 终端继续使用原后台直到关闭，不迁移运行中的 PTY。
- 不把旧终端的命令历史重放到 Core。
- 后端选择固定在每个终端身份上，不因刷新或全局开关变化漂移。
- Core 不可用时明确失败，不静默切换后台并创建第二个终端。
- 临时双后台只服务迁移与回退，不默认演化成永久插件框架。

### 阶段 C：正式内置与删除重复实现

通过验收并批准后，再把 Core 纳入发行包与原生生命周期。仅删除已无生产调用的 DSH 终端后台、headless 屏幕维护及相关 PTY 路径；保留文件和 Office 等其他调用仍使用的子进程能力。

正式迁移必须同步实现、契约、测试、隐私说明、停止语义和产品文档，不能仅切换默认后台。

### 回退原则

- 改变新终端的后台选择，不自动重建已有终端。
- 不对 Core 状态做未经验证的跨版本降级或破坏性修复。
- 已有 Core 终端保留明确的访问与关闭路径；回退不等于遗弃进程。
- 需要结束运行中进程、删除状态或切换不可逆格式时，应作为显式动作说明影响，不借升级自动完成。

## 11. 验证清单与恢复评估条件

| 验证面 | 最低证据 |
| --- | --- |
| 原生交互 | Shell、全屏程序、密码输入、中文／英文／emoji、长文本、粘贴、Tab、方向键、Ctrl+C/D、退格按真实语义工作 |
| 输入确认 | 明确确认阶段；模拟收包后断线、Core 拒绝／退出、未确认输入和尾部回车取消；不以回显判断送达 |
| 输出与背压 | 大量输出、慢手机、重绘、主／备用屏幕、UTF-8 分片；各层内存有界，CREDIT 与实际消费对应 |
| 控制权 | 两个页面抢占、只读连接 resize/focus、旧输入延迟到达、Host 重启后的旧连接失效 |
| 创建与归属 | 创建超时不重复执行；草稿转 Thread；目录缺省与无效显式目录；未知、官方 Codex、远程身份拒绝 |
| 生命周期 | Web 重启、Host 重启、Core 计划与异常重启、页面关闭、标签关闭、全局停止、电脑重启，逐项区分 |
| 安全 | 专用实例不混入用户终端；本地 endpoint 权限；不暴露 Core 全量方法；日志与历史不扩大敏感数据暴露 |
| 平台与发行 | macOS、Windows、Linux 的真实进程监管、PTY、二进制和更新；Windows named pipe 不能按普通 socket 文件处理 |
| 手机体验 | 真机 iOS Safari 与 Android 输入法，键盘遮挡、组字、联想、选区替换、横向滑动；模拟测试仅作补充 |
| 维护收益 | 对比实际删掉的代码与新增适配、监管、分发代码及依赖；没有实测前不承诺“更轻”或“零维护” |

恢复评估前应重新回答：

1. Core 版本和协议是否变化，是否已有可用的逐次输入确认？若没有，是否继续以保持现有保证为门槛？
2. 是否仍只替换 Web 右侧栏本地终端，而不迁移 Harness 执行或接入旧 Herdr？
3. 独立后台能否同时满足“Host/Web 重启不杀终端”和“显式停止可完整清理”？
4. 终端归属、草稿恢复与持久化历史的具体契约是否可以保持精简？
5. 专用实例、固定版本和分发方式是否经过平台验证？
6. 相比继续复用现有 DSH/node-pty 后台，净维护收益是否足够？

上述问题未解决前，现有终端继续使用当前实现。本文不授权自动安装 Core、启动迁移、提交 OpenSpec 实施任务或改动服务行为。

## 12. 证据与版本索引

### 上游固定源码

| 项目 | 核对 commit | 主要证据 |
| --- | --- | --- |
| Herdr | `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde` | [README][herdr-readme]、[Cargo.toml][herdr-cargo] |
| Herdr Core | `7a54c2975225a859b7e7d67302df5efc249fb9d0` | [README][core-readme]、[API][core-api]、[OpenRPC schema][core-schema]、[安全说明][core-security]、[viewer 实现][core-viewers] |
| Herdr App | `1581a587919dddd6f1efd5f78eb542c4b2b02cb5` | [README][app-readme]、[Cargo.toml][app-cargo] |

### 产品与外部参考

- [Alma 官网](https://alma.now)：2026-11-01 直接核对产品说明；不是固定版本的实现文档。
- 第 5 节的作者 X 原帖：由 Grok 检索返回，保留原帖标识用于再次核对，不将检索摘要当作发布验收。
- [Alma Relay README](https://github.com/yetone/alma-relay#readme)、[LICENSE](https://github.com/yetone/alma-relay/blob/main/LICENSE)：2026-11-01 核对；仅支持中继用途与许可判断。
- [现有 Web 终端行为](../product/standalone-web.md#右侧栏)、[现有右侧栏设计](../../openspec/changes/restore-web-right-sidebar/design.md)：区分当前实现与候选替换。
- [现有 Host 客户端通道](../architecture/host-client-channel.md)、[术语表](../project/领域术语表.md)：后续设计需遵守的产品和所有权边界。

研究范围为文档、schema、相关源码及公开产品材料；未安装或运行 Herdr Core 原型，未验证 Alma 二进制、移动端渲染技术、完整兼容性或跨平台存活保证。

[herdr-readme]: https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/README.md
[herdr-cargo]: https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/Cargo.toml
[core-readme]: https://github.com/herdrdev/herdr-core/blob/7a54c2975225a859b7e7d67302df5efc249fb9d0/README.md
[core-api]: https://github.com/herdrdev/herdr-core/blob/7a54c2975225a859b7e7d67302df5efc249fb9d0/schema/README.md
[core-schema]: https://github.com/herdrdev/herdr-core/blob/7a54c2975225a859b7e7d67302df5efc249fb9d0/schema/hc.openrpc.json
[core-security]: https://github.com/herdrdev/herdr-core/blob/7a54c2975225a859b7e7d67302df5efc249fb9d0/docs/security.md
[core-viewers]: https://github.com/herdrdev/herdr-core/blob/7a54c2975225a859b7e7d67302df5efc249fb9d0/crates/herdr-core/src/viewers.rs
[app-readme]: https://github.com/herdrdev/herdr-app/blob/1581a587919dddd6f1efd5f78eb542c4b2b02cb5/README.md
[app-cargo]: https://github.com/herdrdev/herdr-app/blob/1581a587919dddd6f1efd5f78eb542c4b2b02cb5/Cargo.toml
