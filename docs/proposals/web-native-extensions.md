# Web 原生扩展 Phase 1 契约

Phase 1-A 提供共享 schema、文件原语和独立 Node 执行器，不注册 Web 路由、不加载浏览器扩展，也不发布市场索引。下文是 Phase 1-B 三路实现的共同接口；字段以 `@codexhost/shared-contracts` 导出为准。

## 包、信任和市场

- `format: "dsh"` 保持原安装、加载、HMR 与 `codexhost/uiExtensions/*` RPC 不变。原生 ZIP 使用 `format: "codexhost"`；管理列表以 `(format, id)` 区分两轨，不能用裸 ID 去重。
- 根 `manifest.json` 使用 `codexHostExtensionManifestV2Schema`。`desktop: { apiVersion: 1, script, style? }` 沿用 Desktop 的 UI 编程模型；`web: { apiVersion: 1, entry?, style? }` 至少有一个 `.mjs` 或 `.css` 文件；`backend: { apiVersion: 1, entry, targets? }` 使用 `.mjs`。不指定 `backend.targets` 时继承存在 UI 入口的端；仅后台扩展必须指定 targets。两端各自安装、启停、保存设置并运行后端。联合解析器原样接受 Desktop v1，视为 Desktop-only；现有 Desktop v1 安装与 schema 不变，Desktop 消费 v2 不在 Phase 1 范围。
- 已登录本机及远程浏览器都能管理：`context.auth !== undefined`，并复用 `request-trust.ts` 的同源判定；`--no-auth` 不授予管理、设置写入、原生资源或后端访问。原生 DOM/Node 都是可信代码，不是沙箱；同源扩展可以使用当前登录权限。安装/更新前明确展示信任提示；`/extensions` 提供无需加载扩展资源的恢复入口。
- 市场复用 `BytePioneer-AI/codexhost-extensions-registry`：冻结 `catalog.json` 及其可安装的 v1 产物；新客户端读 `WEB_EXTENSION_CATALOG_URL` (`catalog.v2.json`)。`parseExtensionCatalogV2` 跳过并报告坏条目，重复 ID 保留首个有效条目；版本较高的 API 可解析但不视为可安装。索引可同时列出 Desktop v1、跨端 v2 和仅 Web 的 `codexhost` ZIP，不作为 DSH npm 市场；`apis.desktop/web` 表示所列目标支持的客户端 API，`apis.backend` 有后端时填写。Web 只展示 Web 目标，安装时重新验证 ZIP 的实际清单、目标及摘要。刷新失败保留上次有效数据，返回 `stale: true`；没有缓存则返回 `marketUnavailable`。市场不会自动更新用户安装。

## Web 后端与传输（pi）

在 `packages/web-server` 新增 `web-native-extensions.ts`（生命周期）、`web-extension-rpc.ts`（RPC 与传输适配），接入 `main.ts`，不改 DSH 协议。按公开 `WEB_EXTENSIONS_RPC` / `webExtensionsRpcSchemas` 注册，不带参数时发送 `{}`；客户端使用 `WebExtensionsRpcParams<M>` / `WebExtensionsRpcResult<M>`。安装、更新、启停、卸载返回最新混合列表。DSH 安装、启停、卸载转发现有实现；原地更新、设置、市场安装和后端调用只适用原生轨。管理列表 `enabled` 是保存的选择，`backendState` 是当前后台状态，不表示浏览器加载成功。`manifest` 缺失时显示包错误并保留禁用/卸载路径。UI 的失败反馈使用 `WEB_EXTENSION_RPC_ERRORS`，不返回后台堆栈或本地路径。

- **来源与文件**：`POST /api/web-extensions/upload` 接受同源认证下的 `application/zip` 二进制，响应 `{ uploadId }`；token 短时、单次使用、绑定认证主体。限制上传/下载至 64 MiB，上传流式写入暂存，不放宽通用 RPC。GitHub 用 `owner/repo`、可选 tag（省略取 latest）和精确的 Release ZIP 资产名，不接受任意 URL 或运行构建脚本。远程下载限制源、重定向、超时及大小，禁止本机/内网目的地。市场按 `id + version + sha256` 匹配索引；不支持用请求直接替换下载地址。
- **提交**：通过 `prepareWebNativeExtension` 在管理提交锁外验证并暂存；全局限制同时准备的 ZIP 数量（首期 1 个）。`commit(null)` 仅安装新 ID，默认禁用；`commit(expectedDigest)` 仅更新匹配的包，不允许候选换 ID。提交前撤销旧代准入、停止旧后台；提交失败恢复旧代，提交成功保留启用选择并为新包生成新代。文件原语只原子切换 `active.json` 指针，不保证新代码能激活；激活失败显示错误并允许禁用，不承诺自动回滚扩展写入。未提交的准备对象调用 `dispose()`。卸载撤销准入并停止子进程后移除包，保留设置和扩展数据。发现忽略未提交目录；不要扫描或对外托管暂存目录与包根。
- **设置**：Web 数据根下分别使用 `web-native-extensions/` 和 `web-native-extension-data/<id>/settings.json`。设置读写为完整 JSON 对象（≤1 MiB，整对象替换，同一扩展的写入串行化）；schema 是默认表单与字段默认值来源，文件缺失读 `{}`，不把默认值写回文件。带 `activationId` 的设置请求只允许同代有效扩展，不带则是管理页操作，禁用时也能编辑。后台通过注入的 `readSettings` / `writeSettings` 与 RPC 使用同一存储、revision 和生命周期锁。更新、禁用、关闭先阻止新调用及旧代设置写入，再收尾；不要在持有设置写入锁时等待 `stop()`。
- **同步与资源**：`snapshot` 返回已启用且资源可用的原生期望快照；安全模式（`--safe-mode`）或 `--no-auth` 返回空快照，不启动原生后端。`revision`、`activationId`、`settingsRevision` 都是只能比较相等的 UUID；快照内容变化时换 `revision`，每次重启、重启用、更新换 `activationId`，成功写设置换 `settingsRevision`（不触发 UI 重挂）。`hasBackend` 表示该代后台已成功注册并可调用；失败不阻塞有效 UI 加载。静态 GET/HEAD 只接受当前活动代的 `webExtensionAssetBaseUrl(entry) + encodeWebExtensionResourcePath(path)`，使用 `readWebNativeExtensionAsset` 的 MIME 及 `nosniff`，不公开 HTML/SVG/后台入口/设置文件，不使用匿名 `/assets/`。首期 UI 是单个自包含入口，额外公开资源放 `assets/`；市场预览不走运行时资源路由。
- **关闭**：Web 实例自己管理每个启用包的一个 `@codexhost/extension-backend`，而非共享 Host Runtime 的 Desktop 管理器。`readWebNativeExtensionBackend` 返回入口真实路径、SHA-256 和目录身份；以 file URL 传给 `activate`。后端导出 `activate(ctx)`，激活期 `ctx.handle` 注册方法，可返回 disposer；浏览器 `backend/invoke` 必须携带 `activationId`，退役后拒绝。Web 监听和内置恢复页就绪后再启动原生扩展。`main.ts` 的 SIGINT/SIGTERM 统一走幂等的 Web `shutdown()`，先撤销准入，再并发 `stop()` 并等待结束。执行器为超时/失败提供 `terminate()` 并有同步 `exit` 兜底；POSIX 回收进程组，Windows 使用有界 `taskkill /T /F`（需可枚举的进程树）。不支持插件刻意分离子进程或承诺抵抗强制杀死宿主等无法运行退出钩子的情形。

## 浏览器扩展宿主（agy #1）

负责 `apps/web-ui/packages/client/web/src/boot*.ts`，以及 `ui-codexhost/src/client/native-extensions/` 和锚点所在布局。内置页面已挂载后取 `snapshot`，每 2 秒串行拉取、重连或页面重新可见时立即同步；`?extensions=off` 不拉取、不挂载，不改变服务端状态。按 `(id, activationId, digest)` 对账；同代设置变化只回读并通知 `storage.onChange`（不立即回放初值，初值走 `get()`）。销毁时先 abort，再清理托管挂载/标记、link 样式、订阅、页、面板和 disposer。旧代异步完成不得复活挂载。单插件导入或激活失败不阻塞内置页面或其他扩展；不保证撤销插件直接造成的全局副作用。

`WebExtensionModule` 的命名 `activate(api)` 是唯一 JS 入口，纯 CSS 不需 JS。`dom.mount` 接受 `HTMLElement` 或 `data-cx-region` 值并返回宿主所有的 `container`，锚点不存在时返回 `undefined`。首批锚点为 `app`、`topbar`、`sidebar`、`conversation`；容器由宿主回收，不移动 React 管理的节点。`mark/unmark` 用 `data-cx-ext-<id>-<name>`（`name` 用小写字母、数字、连字符）；`track` 收集额外 disposer。设置页/面板按 `(extensionId, contributionId)` 注册并拥有各自的 HTMLElement 和 AbortSignal；`main`/`sidebar` 分别适配现有 `main`/`sidebar.panellist` 插槽，设置页走现有 `settings.section`。贡献渲染不用依赖特定框架，不要求与管理 UI 共用状态。

## 设置页与市场（agy #2）

负责 `ui-codexhost/src/client/WebExtensionsSection*`、`InstallWebExtensionDialog*`，以及独立 `web-native-extension-management-api.ts` 和市场 UI。用混合管理列表表示两轨，保留 DSH npm 安装流程；原生提供二进制 ZIP、GitHub Release、市场入口。原地更新携带当前 digest，不先卸载。使用 `settingsSchema` 渲染默认表单（内存合并默认值；保存只走管理 RPC），市场/列表失败可独立重试。插件自定义设置页是宿主通过插槽注册的另一贡献，不从扩展管理页 import 宿主，也不让恢复流程依赖扩展挂载。

**并行锁定**：三路均从 Phase 1-A 提交直接使用包公开导出，不各自复制 schema，不共同修改 `ui-codexhost/src/client/index.ts` 或旧 DSH API；需要注册设置区的改动归 agy #2，宿主由 Web boot 入口接入。后续集成验收：双浏览器启停和重连、失败更新后的可管理性、安装时核心 PTY 可用、SIGINT/SIGTERM 后无运行中的后代，以及原有 DSH / Desktop v1 不退化。
