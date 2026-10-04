# codexhost 独立 Web 控制台方案

> 状态：第一至第三阶段已实现，见第 12 节。
> 来源：Codex Desktop 更新导致 codexhost 启动失败时，用户无法得知准确原因、也无法在 Codex 外更新 codexhost 的问题讨论。
> 依据（2026-09-28）：源码核对（`crates/launcher`、`crates/platform`、`packages/host-runtime`、`packages/renderer-extension/src/settings`、`packages/update-manager`）；IANA 端口登记表核对；本机 macOS 临时端口范围核对。未做原型验证。

## 1. 背景与目标

现状：

- codexhost 的设置页与更新入口都在 `renderer-extension` 中，只有 Renderer 注入成功后才可见。Codex Desktop 更新导致注入或 Desktop Controller readiness 失败时，用户同时失去诊断入口和更新入口。
- Launcher 失败只 `eprintln!`，仅 Windows 开始菜单启动时弹窗（`crates/launcher/src/main.rs` 的 `main()`）。macOS 双击启动失败时用户看不到任何信息。
- Desktop Controller 在 Renderer 注入失败时仍然报告 ready，并在后台按退避重试（`production-controller.ts`），Launcher 因此认为启动成功。Codex 更新导致注入失败时，常见表现不是启动失败，而是 Codex 正常打开但 codexhost 功能全部缺失，失败原因只留在已脱离终端的 stderr 中。
- Host Runtime 日志（`docs/operations/host-runtime-log.md`）只覆盖 Runtime 自身，Controller / readiness 阶段的失败不在其中。

目标：提供一个**不依赖 Codex Desktop 启动成功**的 codexhost 自有页面，让用户在任何状态下都能：

1. 看到 codexhost 与 Codex Desktop 的当前状态和兼容性；
2. 看到启动失败的阶段和具体原因；
3. 在 Codex 外检查并安装 codexhost 更新；
4. 在 Codex 运行时，使用原设置页中与 Codex 界面无关的设置。

非目标：

- 不内置、不下载、不分发 Codex Desktop（见第 10 节）。
- 不替代 Codex 内的设置页；依赖 Codex 界面的设置保留在原处。
- 备用 Codex 安装、以原版 Codex 回退启动等能力不在第一阶段，另行设计。

## 2. 方案概述

- 新增本地 Web 控制台，固定监听 `127.0.0.1:4399`，端口可配置。
- 安装包与 npm 两种安装方式共用同一套控制台：同一个 `console-server.mjs`、同一个 `codexhost console` 子命令、同一套页面。
- 控制台**只负责转发和安全校验**，业务逻辑复用现有模块与 `codexhost/*` 接口契约，不另写一套后端。
- 两种运行状态：
  - **Codex 运行时**：控制台把请求转发给正在运行的 Host Runtime，行为与 Codex 内设置页一致。
  - **Codex 未运行时**：控制台只提供不依赖 Codex 的部分能力，其余功能明确显示不可用。
- 前端复用 `renderer-extension/src/settings` 的页面代码，把 client 实现换成 HTTP 版本。
- 先做 Web；前端与服务协议保持可被 Tauri 窗口直接加载，是否包装为独立应用以后再定。

## 3. 能力范围

### 3.1 按运行状态划分

| 能力 | 现有接口 / 模块 | Codex 未运行 | Codex 运行 |
|---|---|---|---|
| 总览：版本、安装方式、Codex 安装信息 | `codexhost-distribution.json`、`codexhost inspect` | ✅ | ✅ |
| 启动诊断：阶段时间线、失败详情、历史 | 新增启动记录（第 7 节） | ✅ | ✅ |
| 更新：检查、安装、进度、失败原因 | `update/check·start·status`、`update-coordinator` | ✅ | ✅（转发给 Host Runtime） |
| 日志查看与下载 | `runtime-log.ts` 写出的文件 | ✅ | ✅ |
| Harness 插件列表、可执行文件发现 | `harness/plugins/list`、`harness-discovery` | ✅ | ✅ |
| Harness 启动路径 | `harness/launch-settings/get·set`、`HarnessLaunchSettingsStore` | ✅（直接读写按插件分开的文件） | ✅（转发给 Host Runtime） |
| Harness 实际可用性 | `harness/inspect` | ❌ | ✅ |
| Harness 账号、凭证导入 | `harness/accounts/*`、`credential-imports` | ❌ | ✅ |
| Codex 账号与用量 | `account/list·usage/inspect·refresh` | ❌ | ✅ |
| 会话导入：来源、列表、导入 | `harness/session-import/*` | ❌ | ✅；"打开已导入会话"跳回 Codex |
| 空闲释放、已加载会话 | `settings/idle-release/set`、`sessions/loaded/list` | ❌ | ❌，保留在 Codex 内 |
| 外观 | Renderer 本地偏好 | ❌ | ❌，保留在 Codex 内 |

规则：

- Codex 未运行时，不可用的功能在导航中保留入口，页面显示"需要 Codex 运行中"和启动按钮，不隐藏、不显示过期数据。
- 空闲释放设置按现有设计以 Renderer localStorage 为准并由 Renderer 下发给 Host（见 `external-harness-idle-unload-proposal.md` 第 3.1 节），控制台不修改它。
- Codex 运行时，控制台的**所有写操作必须经 Host Runtime 执行**，不直接写文件，避免与 Host 的缓存或写入冲突。

### 3.2 两种安装方式

两种方式装到本机的核心文件一致：Rust launcher、`app/host-runtime.mjs`、`app/desktop-controller.mjs`、`codexhost-distribution.json`。控制台服务以 `app/console-server.mjs` 形式随两者发布。

| | 安装包 | npm |
|---|---|---|
| Node 来源 | 安装包自带 | 系统 Node（≥22） |
| 打开入口 | 随 codexhost 启动并在浏览器打开；Windows 开始菜单"codexhost console"；Codex 设置页入口 | 随 codexhost 启动并在终端输出地址；`codexhost console`；Codex 设置页入口 |
| 更新 | `update-manager` 的 installer / macOS DMG 路径 | `update-manager` 的 npm 路径 |

- npm 用户的 Node 本身不可用时，控制台无法启动。此时 launcher 在终端打印失败记录摘要；这也是启动失败记录必须由 Rust 写出的原因。
- 控制台触发的更新沿用现有 `codexhost-updater` 流程：交给 updater 后控制台服务退出，由 updater 替换文件，不另写一套自我替换逻辑。

## 4. 页面内容

### 4.1 总览（首屏）

顶部一句话状态 + 一个主要操作：

| 状态 | 示例 | 主要操作 |
|---|---|---|
| 运行中 | codexhost 正在运行 | 打开 Codex |
| 上次启动失败 | 启动失败：Desktop Controller readiness 未通过 | 查看原因 |
| 版本不兼容 | 当前 Codex 26.9xx 超出已验证范围 | 更新 codexhost |
| 有新版本 | codexhost 0.9.3 可用 | 更新 |
| 未运行 | codexhost 未运行 | 启动 |

下方状态卡片：codexhost（版本、安装方式、路径）、Codex Desktop（版本、build、安装路径、平台）、兼容性、运行状态（launcher、Desktop Controller、Host Runtime）。

### 4.2 启动诊断

- 以步骤条展示 launcher 已有的 `startup_trace` 阶段，标出失败所在阶段。
- 失败详情：Controller 返回的不兼容项、原始错误、建议操作。
- 最近若干次启动记录。
- 操作：重试启动、复制诊断信息；导出诊断包与预填 GitHub Issue 放到第二阶段。

### 4.3 更新

当前与最新版本、更新说明（复用 `release-notes.ts`）、`UpdateStatus` 的阶段与进度、失败原因；自动更新失败时给出手动方式（npm 命令或安装包下载链接）。

### 4.4 日志

列出 `<数据目录>/logs/` 下的 Host Runtime 日志，支持查看末尾、关键字过滤、下载。

### 4.5 设置

只放 Codex 起不来时也需要的项：控制台端口、语言、启动追踪开关。以及第 3.1 节中 Codex 运行时可用的原设置页内容（连接、账号、会话导入）。

## 5. 进程与端口

### 5.1 端口

- 默认 `127.0.0.1:4399`，只监听 loopback。选用四位端口，便于记忆。
- 核对结果：IANA 登记表中 4399 未分配（TCP/UDP）；位于注册端口段，低于 macOS / Windows（49152 起）与 Linux（32768 起）的临时端口范围；未发现知名开源项目将其作为默认端口；本机与仓库中无占用。
- 可通过 `CODEXHOST_CONSOLE_PORT` 或控制台设置修改。

### 5.2 单实例与端口冲突

`codexhost console` 及启动失败时的自动打开均执行：

1. 请求 `http://127.0.0.1:<端口>/api/health`。若返回 codexhost 控制台的标识，直接在浏览器打开该地址。
2. 端口空闲则启动 `console-server.mjs`，写入 `<数据目录>/console.json`（pid、端口、所属安装方式与路径、版本），再打开浏览器。
3. 端口被其他程序占用则明确报错，提示通过 `CODEXHOST_CONSOLE_PORT` 修改，不自动顺延，保证地址稳定。

- 安装包与 npm 共存时共用 `~/.codexhost`，因此只有一个控制台实例。页面顶部显示"当前管理：<安装方式> <版本>（<路径>）"。从另一份安装打开时，先停止旧实例再以当前安装重启，避免对错误的安装执行更新。
- 控制台空闲一段时间后自动退出，下次打开时重新启动。

### 5.3 与 Host Runtime 的连接

- Codex 运行时，控制台需要找到本地 Host Runtime 并转发 `codexhost/*` 请求。Host Runtime 已有 `delegation-control-server.ts`（loopback HTTP + token，端点与 token 通过环境变量下发给委派 CLI），控制通道仿照它实现：Host Runtime 启动时把端点与 token 写入数据目录下的描述文件，控制台读取后连接。
- Host Runtime 在控制通道上调用与 app-server 相同的处理逻辑，不新增业务分支。

## 6. 安全

控制台只运行在用户本机，不设登录。固定端口可被浏览器中的任意网页猜到，因此只做以下检查：

- 校验 `Host` 头，只接受 `127.0.0.1:<端口>` 与 `localhost:<端口>`，防 DNS 重绑定。
- 所有写操作（更新、启动、设置修改）只接受 POST，必须携带 `x-codexhost-console: 1` 请求头，浏览器请求的 `Origin` 必须为控制台自身，防跨站请求。
- 导出的诊断信息把用户主目录替换为 `~`。
- 凭证类错误沿用 Host 现有做法，不把原始异常转发给页面。

## 7. 前置改动

以下改动与控制台无关也有价值，应最先完成：

1. **启动记录**：launcher 在每次启动时写结构化记录（阶段、时间、Codex 版本与 build、codexhost 版本与安装方式、失败原因），失败时由 Rust 写出，不依赖 Node。
2. **Renderer 注入状态**：Desktop Controller 把注入状态（注入中 / 正常 / 失败、失败原因、失败次数）写入状态文件，只在状态变化时写入。readiness 契约保持不变：Controller 本来就不会因注入失败而拒绝启动。
3. **`codexhost inspect --json`**：现有 `print_installation` 为 `key=value` 文本，增加 JSON 输出供控制台读取。
4. **失败时打开控制台**：launcher 失败后调用控制台入口；控制台无法启动时退回原有的 stderr 输出（Windows 开始菜单启动仍弹窗）。

## 8. 后端复用与改动

- **拆分 AppServerHost**：`codexhost/*` 的处理逻辑目前集中在 `packages/host-runtime/src/app-server-host.ts`（4622 行）。部分已是独立模块（`harness-accounts.ts`、`session-import-requests.ts`、`harness-launch-settings.ts`、`credential-imports.ts`、`update-coordinator.ts`），更新与插件加载等仍与 app-server 写出耦合。拆出后由 app-server 与控制通道共同调用，同时降低该文件体量。
- **接口契约不变**：控制台沿用 `codexhost/*` 方法名与 `shared-contracts` 中的 schema，只替换传输方式。
- **新增包**：
  - `packages/console-server`（Node）：HTTP、安全校验、单实例、按运行状态分派到 Host Runtime 或本地模块。
  - 控制台前端入口：与 `renderer-extension` 共用 `settings/` 页面代码，只依赖浏览器安全的模块。依赖方向变更前需对照 `tools/check-boundaries.mjs`。
- **前端复用**：`settings/` 页面通过 client 接口取数（`RendererConnectionDiagnostics`、`RendererSessionImportClient` 等），在控制台中提供 HTTP 实现。依赖 Codex 界面的部分（`agent-selection-state`、打开会话、`renderer-codex-account-options`）在控制台中改为"在 Codex 中打开"或不显示。
- **Rust 边界**：launcher 只负责拉起控制台进程、打开浏览器、写启动记录，不承载 Host 协议或 Harness 语义。

## 9. 分阶段计划

1. **阶段一：诊断与更新**
   - 第 7 节前置改动；
   - `console-server`、端口与单实例、安全机制；
   - 页面：总览、启动诊断、更新、日志；
   - 两种安装方式的入口与更新路径。
2. **阶段二：离线可用的设置**
   - 拆分 AppServerHost；
   - Harness 插件列表、可执行文件发现、启动路径；
   - 导出诊断包、预填 GitHub Issue。
3. **阶段三：Codex 运行时的完整设置**
   - Host Runtime 控制通道；
   - 连接、账号、凭证导入、会话导入在控制台中可用。
4. **后续另议**：兼容清单（远程维护 codexhost 版本与已验证 Codex 版本的对应关系）、以原版 Codex 回退启动、备用 Codex 安装、Tauri 独立窗口。

## 10. 未采用的方案

- **内置 Codex Desktop**：涉及再分发 OpenAI 闭源软件；旧版可能被服务端拒绝；新版可能已迁移本地数据，回退存在损坏风险；Windows 为 AppX 包、macOS 有签名与自动更新问题。
- **让用户自行下载旧版作为自动回退**：授权问题不存在，但数据兼容、自动更新、服务端兼容风险仍在，且能否获取指定历史版本未确认。仅保留为后续"用户确认后使用备用安装启动"的候选。
- **随机端口**：无法收藏地址，与常见本地工具（Ollama、Syncthing、Jupyter）的使用习惯不一致。
- **Electron 独立应用**：体积大且与 Codex 重复；如需独立窗口优先考虑 Tauri。
- **在控制台完整复制所有设置**：外观与空闲释放依赖 Codex 界面，复制会造成两处状态不一致。

## 11. 待确认问题

- Windows 在安装 Hyper-V / WSL / Docker 后可能保留端口段，需在多台 Windows 机器上执行 `netsh interface ipv4 show excludedportrange protocol=tcp` 确认 4399 不在其中。
- 本地可能同时存在的 Host Runtime 实例数量及控制台选择规则（含远程 Host 场景是否排除）。
- 控制台空闲退出的时长，以及更新进行中时禁止退出的规则。
- Codex 设置页中控制台入口的位置与文案。
- 兼容清单的托管位置与更新流程。

## 12. 第一阶段实现

### 12.1 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 启动记录 | `crates/launcher/src/startup_record.rs` | 每次 `launch` 记录阶段时间线、Codex 版本、结果与错误，最多保留 10 条 |
| 控制台入口 | `crates/launcher/src/console.rs` | `codexhost console`、`inspect --json`、启动失败后自动打开控制台 |
| 注入状态 | `packages/desktop-control/src/controller-status.ts` | Controller 的 Renderer 注入状态 |
| 控制台服务 | `packages/console-server` | HTTP 服务、请求检查、诊断读取、离线更新、页面 |
| 打包 | `scripts/release/prepare-payload.mjs`、`prepare-npm.mjs` | 两种安装方式均包含 `app/console-server.mjs`；npm 包装脚本新增 `codexhost console` |
| Windows 入口 | `crates/launcher/src/start_menu.rs`、`Installer.iss` | 开始菜单 "codexhost console"，通过 `codexhost-start.exe --console` 打开，不闪命令行窗口 |

运维细节见 [`operations/codexhost-console.md`](../operations/codexhost-console.md)。

### 12.2 与方案的差异

- **控制台随 codexhost 启动**：Launcher 在启动 Codex Desktop 的同时于后台启动控制台，启动结束时安装包启动在浏览器打开、终端启动输出地址；codexhost 运行期间控制台不空闲退出。这样 Codex 更新导致注入失败、Codex 设置页不可用时，用户仍能直接看到控制台。`CODEXHOST_CONSOLE=0` 关闭。

- **Codex 运行时不在控制台更新**：现有更新流程依赖正在运行的 Launcher（Updater 等待 Launcher 退出后安装，macOS 上由 Launcher 拉起 Updater）。控制台在 codexhost 运行时拒绝更新并提示到 Codex 设置页操作；未运行时由控制台进程充当 Updater 等待的对象，拉起 Updater 后自行退出，Updater 沿用原有安装与重启流程，协议不变。
- **不设登录**：控制台只运行在本机，去掉了登录票据、会话与 CSRF 令牌，只保留 Host 校验和写操作的请求头 / Origin 校验。
- **第二阶段未拆分 AppServerHost**：控制台所需的插件清单读取与启动路径存储已移入 `packages/harness-plugin-files`，Host Runtime 与控制台共用；插件清单只读 JSON，不执行插件代码。AppServerHost 其余拆分与第三阶段一起进行。
- **Codex 设置页入口**：放在“关于”页，Host Runtime 新增 `codexhost/console/open`，仅由 Launcher 启动的本地 Host 提供。
- **第三阶段**：Host Runtime 新增控制通道（`console-control-server.ts`，loopback 随机端口 + 令牌，描述文件 `<数据目录>/console/hosts/`）；`AppServerHost.handleConsoleRequest` 以专属请求 ID 走 Desktop 请求的同一处理路径，回复由写出器截获交回控制台，不写给 Codex。允许的方法见 `shared-contracts` 的 `CONSOLE_HOST_METHODS`。codexhost 运行时，控制台的更新也经由 Host。
- **网页**：由 `renderer-extension` 的 `console-entry.ts` 构建为 `console.js`（发布为 `app/console-web.js`），左侧导航；连接、账号、会话导入、更新、关于直接复用 Codex 设置页的页面模块，客户端改为经控制台转发。外观页的设置保存在 Codex 界面，不在网页提供。
- **尚未实现**：Harness 可执行文件发现结果单独展示（连接页已显示可用性与错误）；以原版 Codex 回退启动、备用 Codex 安装、兼容清单。

### 12.3 验证

- 单元测试：`packages/console-server/test`、`packages/desktop-control/test/controller-status.test.ts`、`crates/launcher` 中的启动记录与 `inspect --json`、`tests/release` 中的打包与 npm 包装脚本。
- 本机实测：源码构建下以临时数据目录启动控制台，验证 Host 与写操作请求头 / Origin 拒绝、`inspect --json` 读取本机 Codex、运行中拒绝更新；Playwright 渲染中英文与深浅色页面，无 CSP 违规与脚本错误。
- 未验证：真实安装包与 npm 发布包中的离线更新全流程；Windows 与 Linux 实机运行（仅做了 Rust 交叉 clippy）。
