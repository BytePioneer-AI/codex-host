# Design

## Context

动机与范围见 proposal。下列现状约束决定了方案：

- **三类进程角色**（Launcher 正式路径）：Desktop Controller 由 Rust Launcher 以 `--desktop-controller` 启动，负责 CDP 注入，生命周期跟随 Desktop；Shim 拉起的 host-runtime 只运行 `runLocalDesktopBridge`（`packages/host-runtime/src/local-shared-host.ts`），是到 `/v1/desktop` 的字节管道；Shared Host service（`shared-host-service.ts`）在同一进程中持有 owner `AppServerHost{externalOnly}`，并为每个 Desktop 连接各建一个前端 `AppServerHost`（`shared-host-desktop.ts`），两者通过 `SharedThreadBridge` 的 JSON-RPC peer 通信。dev 路径（`run-host-runtime.ts`）中前端 Host 是独立进程，经 `codexhost-threads.sock` 连接 owner；Windows dev 路径没有 sharedThreads。
- **owner 状态分裂**：运行中集合与待处理交互只存在于执行 Thread 的 owner 中。#926 因此把 owner 上运行中的子 Thread 显示为空闲；#947 在前端手写 `sharedThreads.request(...)` 再合并本地结果。另外，`SharedThreadBridge` 会把 owner 发来的通知原样转发给 Desktop。
- **注入现状**：Controller 只控制第一个 `app://-/index.html` 主页面（`selectPrimaryRendererTarget`）。核心 bundle 先用 `Page.addScriptToEvaluateOnNewDocument` 注册（从不移除），再对当前文档 `Runtime.evaluate`（`renderer-cdp-control-session.ts`）。页面 CSP 禁止 `unsafe-eval`（`production-controller.ts` 中的 `RENDERER_CSP_BOOTSTRAP`）。Controller 已有写 `diagnostics/desktop-controller-v1.json` 状态文件的模式（`controller-status.ts`）。
- **可复用的 renderer 原语**：`SidebarAgentIconRow`/`SidebarAgentIconDom.observe`（`renderer-sidebar-agent-icons.ts`）已经提供稳定的行句柄 `{hostId, threadId, draftId, isConnected}`；`modelClientForHost` 可按 hostId 选择 Host 客户端；`hostHarnessAvailabilityState(hostId).plugins` 缓存了 Harness 名称与已处理的图标。
- **可复用的文件原语**：`harness-plugin-files` 中的 `pluginResourcePath`（基于 realpath 防符号链接逃逸）和 `readPluginFile`（固定上限读取）。Console 目前没有任何插件启停入口，`enabled.json` 只在发布时由脚本写入。

## Decisions

### D1 目录与 manifest

```
$CODEXHOST_DATA_DIR/desktop-extensions/  （默认 ~/.codexhost/desktop-extensions/，权限 0700）
  enabled.json
  <id>/manifest.json
  <id>/desktop.js
  <id>/desktop.css                     （可选）
  <id>/images/sidebar.png               （可选；以 manifest 中的相对路径为准）
```

```json
{
  "manifestVersion": 1,
  "id": "sidebar-thread-tree",
  "name": { "en": "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
  "version": "0.1.0",
  "description": { "en": "…", "zh-CN": "…" },
  "author": "codexhost",
  "repository": "https://github.com/BytePioneer-AI/codex-host",
  "details": { "en": "…", "zh-CN": "…" },
  "screenshots": ["images/sidebar.png"],
  "desktopApi": 1,
  "desktop": { "script": "desktop.js", "style": "desktop.css" },
  "slots": ["sidebar.thread-layout", "sidebar.thread-badge"],
  "categories": ["interface", "workflow"]
}
```

- 新增独立的 `desktopExtensionManifestSchema`（strict），放在 `shared-contracts/src/desktop-extensions.ts`。**不**扩展 `harnessPluginManifestSchema`：它是 `.strict()` 的，`kind` 已被 `"usage"` 占用，扩展混进去会进入 `isAdapter` 判断路径。
- 新扩展提供 `en` 与 `zh-CN` 的名称和描述。`name` 的两种语言必填，兼容旧字符串；`description` 保留既有可选对象格式。发现和列表传递原有双语结构，由客户端按界面语言取值；槽位冲突继续用扩展 id 标识占用者。
- `categories` 使用 `desktopExtensionCategorySchema` 定义的六个用途标签，沿用 `slots` 的重复项校验，省略或留空时视为未分类，不参与槽位互斥。
- `author`、`repository` 和 `details` 是可选的展示元数据。仓库链接仅支持 HTTP(S)；`details` 保留段落和原有语言键，客户端使用与 `description` 相同的本地化规则。
- id 规则与 Harness 插件 id 相同（`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`，最长 128），并且**必须等于目录名**，这样无需处理重复 id。
- 资源路径复用 Harness 的相对路径规则，并经 `pluginResourcePath` 解析。上限：manifest 128 KiB、脚本 2 MiB、样式 256 KiB、最多 64 个扩展，单次注入总量不超过 8 MiB。最多声明四张 PNG、JPEG 或 WebP 截图，每张至多 512 KiB。发现与构建共用受限读取及文件签名校验；打包保留截图的相对路径。截图字节不计入注入快照或实例 hash。
- `backend` 是保留字段：schema 分两步解析，先用宽松外壳读出 `manifestVersion/id/name/version/desktopApi/backend`，再做严格校验。外壳中出现 `backend` 或 `desktopApi > 1` 时报告**不兼容**，其余未知字段报告**无效**。这样 v1 能对 v2 扩展给出可理解的提示。
- POSIX 上，扩展根目录与扩展文件必须属于当前用户，且不可被同组或其他用户写入，否则判为无效。这些代码会注入 Desktop，不能让其他本机用户改写。
- `contentHash = sha256(manifest 字节 ‖ 0x00 ‖ 脚本字节 ‖ 0x00 ‖ 样式字节)`，是"内容是否变化"的唯一依据。

### D2 启用配置 `enabled.json`

```json
{ "version": 1, "revision": 7, "enabled": ["sidebar-thread-tree"], "reloadToken": "<uuid>" }
```

- Console 与本机 Host 设置 RPC 共用跨进程写锁：在同一事务中核对 `expectedRevision`、预检槽位并原子替换配置。修订号不符时报告当前修订号。手工编辑也被接受。
- 文件不存在是正常初始状态：修订号为 0、不启用任何扩展、不报告配置诊断。文件存在但无效（例如无法解析）时同样不启用任何扩展，并报告诊断。
- `enabled` 的数组顺序就是槽位优先级（见 D6）。
- `reloadToken` 只在"禁用全部并重载"时写入（同一次原子写中 `enabled: []`），见 D7。
- Controller、Console 和本机 Host 设置 RPC 读取该文件。Host 只管理选择，不执行扩展代码。
- 读写函数放在 `harness-plugin-files`（`extension-configuration.ts`），格式定义在 `shared-contracts`。

### D3 Controller 对账（desktop-control）

新增 `desktop-control/src/renderer-desktop-extensions.ts`，由 production-controller 持有其生命周期，并接入 `renderer-cdp-control-session.ts` 的 `installTarget` 和 `ensureInstalled`（目标被替换时重新挂接）。

1. **触发**：`fs.watch(root, { recursive: true })`，事件只作提示，防抖 150 ms；另外在 `ensureInstalled`、主页面 `Runtime.executionContextCreated`（`renderer-loaded-modules.ts` 已在监听）时触发；兜底每 30 s 重新计算一次已启用扩展的 hash。正确性**只取决于重新扫描加 hash 比较**，不依赖 watch 事件是否可靠。
2. **计算期望集合**：discover → 过滤已启用且兼容的 → 用 `resolveDesktopExtensionSlots`（D6）得到生效者与冲突项 → 得到 `[{id, hash, slots, script, style}]`，保持 `enabled` 顺序。
3. **未来文档（仅在 Controller 在线期间有效）**：Controller 始终只保留**一个**扩展快照脚本的 `addScriptToEvaluateOnNewDocument` 标识，注册在核心 bundle 之后。集合变化时**先移除旧标识，再注册新标识**；如果在两步之间崩溃，结果是没有扩展，属于安全的方向。快照脚本只做一件事：把期望集合交给注册表，由注册表等宿主桥就绪后再激活。它的作用仅限于在线重载时减少原生侧栏的闪现。
   - 放弃的做法一：按版本调用 addScript。旧标识永不移除，重载后新旧版本会同时运行。
   - 放弃的做法二：只在 `executionContextCreated` 后重新注入。在线重载时每次都会先闪出原生侧栏。
   - **离线重载不恢复扩展**：这类脚本绑定在 CDP 会话的生命周期上，Controller 断开后就不再生效；即使能保留，它也无从得知离线期间启用配置是否已经变化。因此约定：Controller 断开期间重载窗口，扩展不运行。这与核心 bundle 在同样情况下也不注入的行为一致。Controller 重新连接后，立即按最新的 `enabled.json` 走第 4、5 步做幂等对账。放弃了"离线重载也能恢复"的方案，因为它需要一个独立于 Controller、可信的 Desktop 启动注入入口，复杂度与 v1 不相称。
4. **当前文档**：`Runtime.evaluate` 调用 `__codexhostDesktopExtensionsV1.reconcile(entries)`。每个脚本被包装成
   `(function (define) { "use strict";\n<desktop.js>\n})\n//# sourceURL=codexhost-extension://<id>/desktop.js`，
   样式以字符串传入。顺序固定为**先更新快照脚本，再做实时对账**，这样中途重载拿到的也是新集合。
5. **幂等**：注册表按 `id + hash` 判断，hash 相同则不做任何事。Controller 重启后先读取 `status()` 再对账，不会盲目重复注入。
6. **状态文件**：`diagnostics/desktop-extensions-v1.json`，内容为 `{controllerPid, targetId, updatedAt, handledReloadToken, extensions: {id: {state, hash, error?, conflictWith?}}}`。只要有已启用的扩展，就每 5 s 读取一次注册表的 `status()`，并在每次对账后读取。

### D4 Renderer 扩展注册表（renderer-extension）

新增 `renderer-extension/src/desktop-extension-host.ts`（注册表、对账队列、资源回收）和 `desktop-extension-api.ts`（按扩展生成 API）。

- 内部入口 `window.__codexhostDesktopExtensionsV1 ??= { version: 1, reconcile, status, disposeAll }`，**只供 Controller 使用**，不是扩展 API。它独立于 binding probe；probe 被 dispose 时调用 `disposeAll`，被重新安装时复用同一个注册表。
- 扩展的脚本约定：同步调用且只调用一次 `define({ activate(api) { …; return dispose? } })`。`activate` 可以返回 `void`、清理函数，或解析为二者之一的 Promise，激活超时 5 s。
- 对账串行执行：先卸载被移除或 hash 变化的扩展，再按顺序激活新增的扩展。激活前等待 `__codexhostRendererBindingProbeV1.status()` 就绪。

### D5 `activate(api)` 原语（Desktop API v1）

类型从 `shared-contracts` 导出（只包含类型，可在浏览器中使用），供样板和第三方使用：

```ts
interface DesktopExtensionApiV1 {
  readonly id: string;
  readonly apiVersion: 1;
  readonly signal: AbortSignal; // 卸载时 abort；用于 addEventListener(…, { signal })
  sidebar: { observeRows(cb: (rows: readonly DesktopSidebarRow[]) => void): () => void };
  threads: { watchTree(cb: (tree: ThreadTreeSnapshot) => void): () => void }; // 仅本机 Host
  navigate: { openThread(threadId: string): Promise<void> }; // 仅本机 Host
  harnesses: { describe(harnessId: string): { name: string; icon?: string } | undefined };
  dom: {
    mount(
      node: Element,
      parent: Element,
      position?: "append" | "prepend" | "before" | "after",
    ): void;
    mark(target: Element, name: string): void; // 写入 data-cx-<id>-<name>
    unmark(target: Element, name: string): void;
  };
  track(teardown: () => void): void;
}
interface DesktopSidebarRow {
  readonly element: HTMLElement;
  readonly hostId: string | null;
  readonly isLocal: boolean;
  readonly threadId: string | null;
  readonly draftId: string | null;
  isConnected(): boolean;
}
```

- `sidebar.observeRows` 封装 `SidebarAgentIconDom`。`navigate.openThread` 使用 Desktop 导航总线的 `navigate-to-route /local/<id>`，并把 #947 的 `openCodexThread` 并入 `codex-schedule-navigation.ts`。`harnesses.describe` 读取本机 Host 的 Harness 目录缓存。`threads.watchTree` 通过 `clientForHost("local")` 订阅 D8 中的接口，同一个页面的多个扩展共享一份 Host 订阅。
- **不开放**：通用 Host RPC、写操作、Composer 挂载与写入、model control、`loadCodexNativeServices`、React fiber、原生 RPC 函数、binding probe 本身。这些私有绑定只由宿主桥使用，方便 `codexhost-update-impact-audit` 审计。
- `mark` 的名称限定为 `[a-z][a-z0-9-]{0,31}`。扩展应在自己的 CSS 中通过标记属性改变原生元素，例如隐藏原生子行；不要直接改原生元素的 style 或 class。只有这样，卸载时才能还原。
- 所有从桥调用到扩展的回调都包在 try/catch 中。30 s 内出错 5 次，扩展就进入 `failed` 并被回收。

### D6 槽位互斥

- v1 的槽位目录是 `sidebar.thread-badge`（侧栏行上的 Agent 图标装饰）和 `sidebar.thread-layout`（重排、缩进、隐藏原生侧栏行），定义为 `shared-contracts` 中的枚举。未知槽位会让 manifest 无效。
- 冲突判定是纯函数 `resolveDesktopExtensionSlots(enabledOrder, manifests)`，放在 `shared-contracts`（不依赖运行时，可在浏览器中使用）。Console 用它在启用前预检，Controller 用它计算生效者，注册表在激活时再做一次防御性检查。
- 槽位采用**声明式**：激活时由宿主统一占用 manifest 中声明的全部槽位，要么全部占用成功，要么不激活。放弃运行时动态 `api.slots.claim`，因为 Console 无法提前判断冲突。
- 样板分配：#926 角标扩展声明 `sidebar.thread-badge`；#947 委派树扩展声明两者（树行自带子 Thread 计数），因此两者互斥。

### D7 管理接口与 Console 兜底

- console-server 新增 `src/extensions.ts` 和以下路由，沿用现有 `request-guard`：
  - `GET /api/extensions`：返回 discover 结果、保存的选择和状态文件（Controller 进程不在时显示"等待 Desktop"）。Console 与 Host 设置列表在有效扩展项中按 `manifest.screenshots` 顺序附带 `screenshotDataUrls`。原始截图合计最多 8 MiB，按目录名排序依次分配；预算不足则省略对应扩展的整组预览并报告列表诊断，不影响其状态。客户端直接使用图片 data URL，不读取本机文件路径。
  - `POST /api/extensions/enable|disable {id, expectedRevision}`：enable 时做兼容性检查和 D6 冲突预检，冲突时返回 409 并给出占用者。
  - `POST /api/extensions/disable-all-and-reload`：原子写入 `enabled: []` 和新的 `reloadToken`。
- Controller 发现 `reloadToken` 与状态文件中的 `handledReloadToken` 不同时，依次执行：移除快照脚本标识 → 实时对账为空集合（有超时，尽力而为）→ `Page.reload` → 记录 `handledReloadToken`，避免 Controller 重启后再次触发。若读取到令牌时已有更新的非空启用集合，则只记录令牌，按新集合对账，不重载。
- 整个兜底流程只依赖文件和 Controller，**不依赖 Host 或 Desktop 界面可用**，Console 自身也不需要 Desktop。
- 独立 Console 页面放在 `renderer-extension/src/console/pages/extensions.ts`。Desktop 与认证同源 Web 设置通过 `codexhost/desktop/extensions/*` 的四个固定方法访问本机 Host；接口分别报告保存成功、槽位冲突或修订号冲突。该接口不是扩展宿主 API。

### D8 主干 `thread/tree/watch`（host-runtime）

- 协议：
  - `codexhost/thread/tree/watch {}` 返回 `{subscriptionId, snapshot}`。
  - `codexhost/thread/tree/unwatch {subscriptionId}`。
  - 通知 `codexhost/thread/tree/snapshot {subscriptionId, snapshot}`。
  - `snapshot = {revision, parents: Record<childId, parentId>, nodes: Record<threadId, {harnessId, title?, status: "running" | "waiting" | "idle" | "unknown", archived}>, truncated}`，最多 5000 个节点。
- `parents` 直接复用 `ThreadTree.read()` 的语义（`thread-tree.ts`），与 Web 一致。
- 实现放在新模块 `host-runtime/src/thread-tree-watch.ts`。`app-server-host.ts` 已有 7000 多行，只在其中加路由。连接关闭时释放该连接的全部订阅。
- **owner 合并**：前端 Host 有订阅者时，经 `SharedThreadBridge` 向 owner 订阅**同一个** `thread/tree/watch`，用一条 owner 订阅服务这个前端 Host 的所有本地订阅者。对 owner 拥有的 Thread（依据 `ownership` 或已知集合），采用 owner 快照中的状态，其余 Thread 用本地状态。owner 断开或不支持该方法时，owner 拥有的节点报告 `unknown`，诊断只记录一次。`SharedThreadBridge` 必须**截获** owner 发来的 `thread/tree/snapshot`，不能像其他 owner 通知那样转发给 Desktop。
- **状态来源**：`waiting` 覆盖审批、提问（直接检查 Desktop 待处理多选提问，不改变 Delegation 提问契约）和计划审阅。官方 Codex Thread 的状态来自前端 Host 观察到的官方 Turn 通知和待处理请求。
- **初始状态**（Turn 事件之前没有观察记录时）：订阅建立时，以及有官方 Thread 新进入树关系时，对这些 Thread 各执行一次只读的官方 `thread/read`，不 resume，不加载 Thread，并限制并发数和单次数量。返回值按以下规则映射：
  - `active`：活动标记表明在等待审批或用户输入时为 `waiting`，否则为 `running`；
  - `idle`：为 `idle`；
  - `notLoaded`、`systemError`、读取失败、超时，或无法确认该 Thread 由前端 Host 连接的官方运行时执行：一律为 `unknown`。
    **绝不把"没观察到 Turn"当成 `idle`**。之后到来的 Turn 和交互事件会覆盖初始值；同一个 Thread 不重复读取。外部 Thread 不走这条路径，它们的初始状态由各自的执行所有者直接给出。
- **推送**：订阅以下事件——已有的 `tree/changed` 触发点、Turn 开始与结束、交互出现与处理完成、标题变化——合并窗口 250 ms，保证在 1 s 内送达。
- Web 的 `tree/read` 和 `tree/changed` 不变。#926 的 `delegation-children` 和 #947 的 `thread/tree/nodes` 不合入主干。

### D9 包边界与新增位置

| 包                                                                            | v1 新增                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared-contracts`                                                            | `desktop-extensions.ts`：manifest、启用配置、状态文件 schema，槽位枚举与 `resolveDesktopExtensionSlots`，`DesktopExtensionApiV1` 类型；`thread-tree-watch.ts`：订阅协议 schema |
| `harness-plugin-files`                                                        | `extension-discovery.ts`、`extension-configuration.ts`，复用文件原语；包名不改，只更新 CLAUDE.md 中的描述                                                                      |
| `desktop-control`                                                             | `renderer-desktop-extensions.ts`（watch、hash、快照脚本、实时对账、状态文件、重载令牌）                                                                                        |
| `renderer-extension`                                                          | `desktop-extension-host.ts`、`desktop-extension-api.ts`、Console 扩展页面；不引入 Node 内置模块                                                                                |
| `host-runtime`                                                                | `thread-tree-watch.ts`、owner 订阅合并，以及 `SharedThreadBridge` 的截获逻辑                                                                                                   |
| `console-server`                                                              | `extensions.ts` 与路由                                                                                                                                                         |
| `tools/build-desktop-extension.mjs`                                           | 用仓库已有的 esbuild 打成单文件经典脚本，写出 manifest；参照 `tools/build-cursor-plugin.mjs`                                                                                   |

- #926 和 #947 的适配源码保存在 `handoff/desktop-extensions-926-947`，不随主干分发。
- Rust 和 Launcher 不改：Controller 已能拿到 `CODEXHOST_DATA_DIR`。

### D10 v2 后端预留（本变更不实现）

- manifest 中的 `backend` 字段保留，v1 报告为不兼容。`desktopApi: 2` 会增加 `api.backend.request(method, params)` 和 `api.backend.onEvent(cb)`。
- 方法命名空间 `codexhost/extension/<id>/*` 预留，v1 的 Host 不注册任何该前缀的方法。
- 后端运行时**每个 Shared Host service 进程一份**，挂在 `shared-host-service.ts` 的组合根，与 owner 平级，**绝不**挂在 `AppServerHost` 实例上。前端 Host 通过同进程引用直接调用，**不经** `SharedThreadBridge`。
- 隔离方式：`worker_threads` 加 `resourceLimits`，只传可序列化的 RPC；`spawnManaged` 按扩展跟踪子进程树，禁用时回收；整体退出仍由 Rust 监管进程（Job Object 或进程组）兜底。只支持 Launcher 拓扑。
- v2 新建 `extension-runtime` 包，由 host-runtime 通过公共契约装配。验收样板为 #728。

## Risks / Trade-offs

- [Codex Desktop 改版导致扩展自身的选择器失效] → 行映射、导航和 Harness 信息由宿主桥统一维护并纳入兼容审计；扩展自己写的选择器风险由扩展作者承担，Console 显示失败状态，"禁用全部并重载"兜底。
- [扩展绕过 `dom.mount`/`mark` 直接修改原生 DOM 或打补丁] → 规范只承诺回收经原语登记的资源；文档要求用标记加 CSS；最终兜底是重载窗口。
- [`fs.watch` 在网络文件系统或特定平台上漏报] → 正确性依赖扫描加 hash，watch 只是加速；`ensureInstalled` 和 30 s 周期扫描兜底。
- [作者保存文件的过程中读到写了一半的文件] → 防抖后读取；语法错误让新版本激活失败，旧版本已被卸载，Console 显示失败，再次保存即恢复。不做"保留旧版本"，避免出现两套状态。
- [快照脚本注入时机早于宿主桥就绪] → 注册表排队，等 binding 就绪再激活。重载时可能短暂闪出原生侧栏，可以接受。
- [owner 版本较旧，没有 `thread/tree/watch`] → owner 拥有的节点报告 `unknown`，诊断只记录一次，不让读取失败。
- [单次 evaluate 载荷过大] → 单扩展和总量都有上限；hash 未变的扩展不重新传脚本。
- [Controller 断开期间重载窗口，扩展暂时消失] → 这是有意的约定（见 D3），与核心 bundle 的行为一致；Controller 重新连接后自动恢复，Console 期间显示"等待 Desktop"。
- [扩展是受信任代码，可以绕过 API 调用 Desktop 私有能力] → 明确定位为受信任代码，沿用 Harness 插件的信任立场；文件属主和权限检查防止其他本机用户注入。

## Migration

- 不迁移已有数据：扩展根目录不存在时，功能完全处于未启用状态。旧 manifest 的字符串 `name` 和未声明 `categories` 的格式仍可发现。
- 回滚：移除功能后 `~/.codexhost/desktop-extensions/` 和 `diagnostics/desktop-extensions-v1.json` 不再被读取，可以直接删除。之后打开的 Desktop 不会再注册扩展快照脚本；已打开的 Desktop 窗口重载一次即可清除。
- #926、#947 关闭或改为扩展 PR，它们新增的 Host 方法不进入主干，不存在兼容负担。

## Open Questions

- v1 是否在 Console 中提供"从本机目录安装（复制）"，还是只写手工复制的文档？两者都不影响规范与任务划分，默认先只写文档。
