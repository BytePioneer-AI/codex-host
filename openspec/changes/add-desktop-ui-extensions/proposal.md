# Proposal

## Why

社区提交的 Desktop 界面增强（#926 侧栏委派角标、#947 侧栏委派树）用户偏好分化大，又深度依赖 Codex Desktop 私有 DOM，全部合入主干会长期背负兼容成本。两者还各自实现了一遍"按共享 Host 所有者合并的 Thread 树状态"，这部分本应由主干统一提供。现在需要一个可选装、可热启停的 Desktop 界面扩展机制，并把共用的 Host 数据面收回主干。

## What Changes

- 新增 Desktop 界面扩展：用户把扩展目录放进独立根目录 `$CODEXHOST_DATA_DIR/desktop-extensions/`（默认 `~/.codexhost/desktop-extensions/`，不与 Pi Adapter 的 `extensions/` 共用），在 Console 中启用、禁用。Desktop Controller 不重启 Codex Desktop、不刷新窗口，直接把变化应用到正在运行的 Desktop 窗口；窗口重载后按最新启用集合恢复。
- 扩展包含 `manifest.json`、`desktop.js`、可选的 `desktop.css` 和本地展示截图。脚本通过按扩展作用域传入的宿主 API 使用 v1 原语：侧栏行观察、Thread 树订阅、Thread 跳转、Harness 展示信息、受管 DOM 挂载与标记、卸载信号。宿主在卸载时强制回收这些原语登记的资源。
- 扩展在 manifest 中声明双语名称、描述及可选的作者、仓库链接、双语详情、分类标签和截图路径；发现兼容旧有字符串名称。管理列表仅返回校验通过、大小受限的本地截图 data URL。分类独立于界面槽位：同一槽位只能有一个扩展生效，Console 在启用前提示冲突。
- Console 增加扩展列表、启停、运行状态，以及"禁用全部扩展并重载 Desktop 窗口"的兜底操作；Desktop 和通过身份验证的 Web 设置连接可通过本机 Host RPC 管理同一份选择。
- 主干新增 Desktop 可用的 Thread 树订阅：推送委派父子关系，以及每个相关 Thread 的 Harness、标题和实时状态（运行中、等待处理、空闲）。状态始终来自实际执行该 Thread 的 Host。
- 仓库提供两个样板扩展，用于验收 #926 和 #947 的界面能力；这两个 PR 的 Host 侧接口由 Thread 树订阅替代。
- v1 明确不做、留给 v2：扩展后端（`backend.mjs`、`worker_threads`、命名空间 RPC/HTTP、受管子进程）、在 Web 中运行 Desktop 扩展、多 Desktop 窗口、远程 Host 的行、Composer 挂载点、通用 Host RPC、安装/市场/自动更新、预装扩展。#728（本地 HTML 预览）作为 v2 验收样板。

## Decisions

- **扩展属于受信任代码**：宿主 API 是稳定性边界，不是安全边界。v1 不做沙箱，也不承诺撤销扩展对原生对象的任意副作用；"禁用全部并重载"是最终兜底。
- **使用独立根目录和独立 manifest**：不复用 Harness 插件根目录，也不扩展 Harness manifest 的 `kind`，以免 Harness 发现流程把扩展误报为无效插件，也避免把扩展混入 Adapter 加载路径。
- **只开放只读白名单数据**：不提供通用 Host RPC，避免把内部协议和写操作冻结成扩展契约。Codex Desktop 私有绑定只由宿主桥使用。
- **槽位采用声明式**：槽位写在 manifest 中，由宿主在激活时统一占用。放弃运行时动态占用，因为 Console 无法提前判断冲突。
- **不同时支持多种拓扑**：Thread 树订阅只在 Desktop 连接的前端 Host 上提供，并以所有者 Host 的运行状态为准；v1 不引入扩展后端，因而不涉及后端进程归属。

## Capabilities

### New Capabilities

- `desktop-ui-extensions`：Desktop 界面扩展的安装形态、启停与热应用、宿主 API 原语、资源回收、槽位互斥、故障恢复与管理。
- `thread-tree-watch`：面向 Desktop 的 Thread 树订阅，提供按所有者合并的关系与实时状态。

### Modified Capabilities

- `renderer-cdp-control`：按源内容和绑定状态保留已安装的 Renderer，替换目标时清除可达的旧扩展快照注册。
- `web-thread-tree`：明确"Codex Desktop 侧栏保持原样"只约束主干行为；用户主动启用的 Desktop 扩展可以改变侧栏呈现，但不改变 Thread 归属、执行、置顶或归档。

## Impact

涉及 `shared-contracts`（扩展与订阅契约）、`harness-plugin-files`（扩展文件发现与启用配置）、`desktop-control`（注入对账与状态文件）、`renderer-extension`（扩展宿主与 Console 页面）、`host-runtime`（Thread 树订阅、扩展管理 RPC）、`web-server`（设置请求权限边界）、`console-server`（独立扩展管理入口），提供扩展构建工具并更新相关文档。用于验证平台的 #926 和 #947 适配源码保存在 `handoff/desktop-extensions-926-947`，不随主干分发。不改 Rust、Harness Adapter、Mapping Store 格式或官方 Codex 流量归属。
