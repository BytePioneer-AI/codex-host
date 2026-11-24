# Design

## Context

- Hub 侧现状：`PeerHostManager` 为每个 Peer 建一个 `PeerHostClient`，它订阅远端 `/api/ch/v1/events`（只用来触发整机目录刷新），并把 `RemoteSessionOperation` 翻译成 `/api/ch/v1/rpc|snapshot|respond`。`RemoteSessions` 是所有 `web-remote:` 会话的门面（Desktop 远程与 Peer 共用），用 `readRemoteHistory` 整段读取、`followRemoteHistory` 1.5 秒轮询、`ChThreadView` 投影；`summary()` 固定 `attachmentInput: { enabled: false }`。
- 直连现状：`ChSessions` 组合 `ChHostClient` + `ChRealtime` + `ChThreadHistory` + `ChHarnessCatalog` + `ChThreadTree` + `readSessionPage`（`codexhost/thread/catalog/read`）。这些类只依赖 `ChHostClient` 接口。
- 远端附件现状：`ChSessions.uploadFile` → `ChFileInputs.upload`（归属校验）→ `WebFiles.upload`，凭证按 sessionId 绑定 1 小时；`session/prompt` 用 `ChFileInputs.prepare` 解析凭证；`WebFiles.bind(from, to)` 迁移凭证归属。
- 前端：`threadTreeParentOf` 对 `remoteHost` 一律返回 null；`SessionHarnessIcon`/`HarnessSelect` 固定 `/harness-icons/<id>`；`ChatView` 对远程会话不解析图片路径。

## Decisions

### D1. Phase 1 复用边界

| 关注点 | Peer 实现 | 复用的直连组件 |
| --- | --- | --- |
| Host 接口 | `PeerChHostClient implements ChHostClient`（新） | — |
| 实时失效 | 每 Peer 一个 `ChRealtime` | `ch-realtime.ts`（不改） |
| 历史 | 每个打开的 Peer Thread 一个 `ChThreadHistory` | `ch-thread-history.ts`（加 `hostThreadId` 选项） |
| Harness 目录/检查/图标 | 每 Peer 一个 `ChHarnessCatalog` | `ch-harness-catalog.ts`（不改） |
| 目录与归属 | `readSessionPage(host, …, readPins = async () => [])` | `ch-session-page.ts`（不改） |
| 委派树/祖先补齐/归档级联 | 每 Peer 一个 `ChThreadTree` | `ch-thread-tree.ts`（不改） |
| 写操作 | 现有 `PeerHostClient.call(op)` | 不变 |

新增类只有两个：`PeerChHostClient`（协议适配）与 `PeerThreadSource`（每 Peer 的组合根，持有上表组件）。`RemoteSessions` 仍是 `web-remote:` 的唯一门面，Peer 条目的读路径委托给对应 `PeerThreadSource`；Desktop 远程条目的代码路径不变。

### D2. `PeerChHostClient` 契约（`packages/web-server/src/peer-ch-host-client.ts`）

```ts
export interface PeerChTransport {
  /** POST /api/ch/v1/<route>，返回响应 JSON 的 `result`；错误按 peerFetch 规则映射为 RpcError。 */
  post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T>;
  /** 由 PeerHostClient 的 /api/ch/v1/events 循环喂入；见下方事件规则。 */
  subscribe(listener: (update: HostClientUpdate) => void): () => void;
  manifest(): RemotePeerManifest | undefined;
}
export class PeerChHostClient implements ChHostClient {
  constructor(transport: PeerChTransport);
  request<T>(method: string, params: Record<string, unknown>): Promise<T>; // post("rpc", { method, params })
  projects(threadIds: string[]): Promise<ChProjectSnapshot>; // 由 manifest.projects 派生：rootPaths=[path]，assignments 取 threadIds 交集
  pins(change?: ChPinChange): Promise<string[]>;             // 复用 requestPins 语义；本变更无调用方
  close(): void;
  readonly realtime: { subscribe; request; snapshot(threadId, options); respond(input) };
}
```

事件规则（`PeerHostClient` 实现 `PeerChTransport.subscribe`）：
- 每行 NDJSON 按 `clientChannelEventSchema` 解析，失败行丢弃（不断流）；成功事件原样分发。
- 首个 `hello` 到达时分发 `{ type: "connection", online: true }` 再分发该 `hello`；流断开或进入 `offline`/`auth-error` 时分发 `{ type: "connection", online: false }`。
- 新订阅者立即收到当前 `connection`；若在线且已有游标，再收到 `{ type: "hello", version: 1, cursor, reset: false }`。
- `PeerHostClient` 删除 `isCatalogChangingEvent` 触发的目录刷新；目录刷新只由 `PeerThreadSource` 的 `ChRealtime.catalog` 回调触发。连接状态与 manifest 变化仍走 `onChange`。

`peerFetch`（Track 0 从 `PeerHostClient` 私有 `fetch` 抽出，行为不变）：

```ts
export function peerFetch(record: PeerRecord, path: `/api/${"ch" | "peer"}/v1/${string}`, init?: {
  method?: string; headers?: Record<string, string>; body?: BodyInit | object;
  signal?: AbortSignal; timeoutMs?: number; duplex?: "half";
}): Promise<Response>;
```
固定 `authorization: Bearer <token>`、`redirect: "error"`；对象 body 才 JSON 编码；错误映射保持现状：401/无消息 403 → `remote/auth-error`，其它非 2xx → `remote/request-failed`（带 `hostCode`），网络错误 → `remote/offline`。

### D3. `PeerThreadSource` 契约（`packages/web-server/src/peer-thread-source.ts`）

```ts
export interface PeerThreadSourceOptions {
  hostId: string;                                   // remote-peer:<peerId>
  host: PeerChHostClient;
  onCatalogChanged(): void;                         // → RemoteSessions.hostsChanged(hostId)
  onThreadChanged(threadId: string): void;          // → RemoteSessions.read(remoteSessionId(hostId, threadId))
  onConnection(online: boolean): void;
  /** Phase 2 由 Track D 传入；缺省时不投影图片（不读本机文件）。 */
  projector?: (threadId: string) => {
    projectInput(content: unknown[]): unknown[];
    projectImage(path: string, projectionKey: string): unknown;
  };
}
export class PeerThreadSource {
  readonly catalog: ChHarnessCatalog;  // events 参数传一个只吞事件的 EventHub，不发本机全局 harness-inspection-changed
  readonly tree: ChThreadTree;
  readonly realtime: ChRealtime;
  listThreads(): Promise<{
    rows: ChThread[];                         // 原生 Thread（id 为远端原生 ID）
    harnessIds: ReadonlyMap<string, string>;  // threadId → harnessId（catalog/read ownership；codex 记为 "codex"）
    archivedIds: ReadonlySet<string>;
    parents: Readonly<Record<string, string>>; // tree/read，原生 ID
    ownershipAvailable: boolean;              // false 表示已回退到 thread/list
  }>;
  history(threadId: string, sessionId: string, origin?: number): ChThreadHistory; // 创建或复用
  follow(threadId: string): () => void;       // ChRealtime.follow 引用计数
  discard(threadId: string): void;
  close(): void;
}
```

- `listThreads`：循环 `readSessionPage(includeArchived=false)` 直到 `nextCatalogCursor` 为 null，最多 100 页，游标不前进报 `remote/read-failed`；并行 `tree.refresh()`，再 `tree.supplement` 补齐祖先。远端拒绝 `codexhost/thread/catalog/read`（`hostCode === -32601` 或 `host/method-unavailable`）时回退到 `thread/list` 分页（行为同现状，`ownershipAvailable=false`）；`tree/read` 失败时 `parents = {}`。
- `history`：`new ChThreadHistory(host, { ...row, id: sessionId, cwd: "" }, harnessId, listener, origin, projector?.projectInput, projector?.projectImage, { hostThreadId: threadId })`。
- `PeerHostManager` 在 `install` 时为每个启用的 client 创建 source，`close`/重装时关闭；新增 `client(hostId)` 与 `source(hostId)` 访问器（`hostId` 非 `remote-peer:` 返回 undefined）。

### D4. `ChThreadHistory` 的 `hostThreadId` 选项

构造函数新增末位可选参数 `options?: { hostThreadId?: string }`。设置后：所有 Host 请求（`thread/turns/list`、`snapshot`、`thread/read`）使用 `hostThreadId`；Host 返回的 thread 在写入视图前把 `id` 与 `cwd` 改回视图自身的值（展示 ID = `web-remote:` 会话 ID，cwd 恒为 `""`）。未设置时行为完全不变。

### D5. `RemoteSessions` 的 Peer 读路径（Track A）

- `constructor(events, call, workspaces, peers?: { source(hostId: string): PeerThreadSource | undefined })`。
- 列表：Peer 主机用 `source.listThreads()` 取代 `invoke({ kind: "list" })`；保留新建 Thread 未入目录时的 `createdEpoch` 保留逻辑。
- 摘要（Peer 条目）：`harnessIdentity = { id, name: await source.catalog.name(id) }`（不再带 base64 `icon`）；`threadTreeParent = parent ? remoteSessionId(hostId, parent) : null`（仅当 parent 与子同属该 Peer）；`ownershipAvailable=false` 时沿用现有归属推断且不输出 `threadTreeParent`。
- 读取与跟随：`read(id)` 对 Peer 条目调用 `source.history(...).refresh(force)`，视图存入 `entry.view`；队列与待处理审批取自 `view.ownerSnapshot`（`queue`、`interactions` 映射为 `{ ...request, id: requestId }` 后进入现有 `interactions()`），不再调用 `queue`/`read` 操作；`session/follow` 对 Peer 条目改为 `source.follow(threadId)` + `view.log.follow(...)`，`sink.onClose` 时释放；`session/page` 走 `ChThreadHistory.olderPage`。Desktop 远程仍走 `followRemoteHistory`。
- 控制：`entry.controls` 由 `parseRemoteControls({ configuration: <codexhost/thread/inspect，每个视图读取一次、configure 后与 epoch 变化时失效>, nativeSettings: snapshot.configuration.native, inspection: await source.catalog.inspect(harnessId, row.cwd), harness: <catalog.list() 中的描述，不含 icon> })` 构造，继续由 `applyRemoteControls`、`remoteModelCatalog`、`selectRemoteModel` 消费。
- 草稿：`RemoteProjectDraft.catalog` 改为接收加载函数 `catalog(load: () => Promise<Catalog>)`；Peer 草稿传 `() => source.catalog.models()`，Desktop 远程草稿传现有 `loadCatalog(target, call)`。
- 归档：Peer 条目的 archive/unarchive 用 `source.tree.archive(threadId, archived, archivedIds, (child) => invoke({ kind: "archive", ... }))` 级联。
- `PeerHostClient.call` 删除改造后无调用方的分支（预期 `list`、`read`、`projectHarnesses`、`inspectHarness`，以 grep 为准）。

### D6. ID 映射规则

| 场景 | 规则 |
| --- | --- |
| 浏览器会话 ID | `remoteSessionId("remote-peer:<peerId>", nativeThreadId)` = `web-remote:` + base64url(JSON `[hostId, threadId]`)（现有） |
| 草稿 ID | `web-remote:draft-<uuid>`（现有） |
| 树父节点 | 原生 parent → `remoteSessionId(sameHostId, parent)`；不同主机 → null |
| `ChRealtime` / `ChThreadTree` / 目录内部 | 一律原生 ID，出 source 时映射 |
| 图标 | `/harness-icons/peer/<peerId>/<encodeURIComponent(harnessId)>`、`/harness-icons/peer/<peerId>/presentation.json`；`codex` 始终用本机 `/harness-icons/codex` |
| 上传 | 浏览器 `/api/session/uploadFileBinary?sessionId=<web-remote:…>`（路径不变）→ 远端 `?threadId=<原生>` 或 `?scope=<uuid>` |
| 文件预览 | 浏览器 `GET /api/remote-peer/file?sessionId=<web-remote:…>&path=<原文>` → 远端 `GET /api/peer/v1/file?threadId=<原生>&path=<原文>` |
| 用户消息图片 | `attachmentId = "peer-image:" + sha256hex(JSON [nativeThreadId, path])`，经 `session/attachment` 读取 |

### D7. 共享契约（Track 0，`packages/shared-contracts/src/remote-peers.ts`）

```ts
export const remotePeerCapabilitiesSchema = z.object({
  /** /api/peer/v1/uploads、/api/peer/v1/prompt、/api/peer/v1/file 同时可用 */
  attachments: z.literal(1).optional(),
});
// remotePeerManifestSchema 增加：capabilities: remotePeerCapabilitiesSchema.optional()
export const REMOTE_PEER_UPLOAD_SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const REMOTE_PEER_FILE_PROXY_PATH = "/api/remote-peer/file";
export function remotePeerHarnessIconPath(peerId: string, harnessId: string): string;
export function remotePeerHarnessPresentationPath(peerId: string): string;
export const remotePeerPromptParamsSchema = z.strictObject({
  threadId: z.string().min(1).max(1024),
  scope: z.string().regex(REMOTE_PEER_UPLOAD_SCOPE_PATTERN).optional(),
  requestId: z.string().min(1).max(256).optional(),
  mode: z.enum(["queue", "steer"]).optional(),
  expectedTurnId: z.string().min(1).max(1024).nullable().optional(),
  content: z.array(z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), text: z.string() }),
    z.strictObject({ type: z.literal("file"), receiptId: z.string().min(1).max(128) }),
  ])).min(1).max(64),
});
export const remotePeerUploadResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.object({ receiptId: z.string().min(1), file: z.object({ attachmentId: z.string(), name: z.string(), bytes: z.number().int().nonnegative() }) }) }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) }),
]);
export const remotePeerPromptResultSchema = /* 同形 envelope，value: { accepted: true } */;
```

旧 Hub 解析新 manifest 时未知字段被剥离；新 Hub 解析旧 manifest 时 `capabilities` 缺失即视为无附件能力。

### D8. 远端端点（Track B，`packages/web-server/src/peer-attachments-http.ts`）

```ts
export async function servePeerAttachments(
  request: IncomingMessage, response: ServerResponse, route: "uploads" | "prompt" | "file",
  deps: {
    sessions: Pick<ChSessions, "uploadFile" | "localWorkspaceRoot">;
    files: Pick<WebFiles, "upload" | "bind" | "reference">;
    images: Pick<WebImages, "idForPath">;
    rpc: Pick<RpcRegistry, "dispatch">;
  },
): Promise<void>;
```

均位于现有 `/api/peer/v1/*` 认证与同源闸门之后，由 Track D 在 JSON body 解析之前分流。

| 路由 | 输入 | 行为 | 输出 |
| --- | --- | --- | --- |
| `POST /api/peer/v1/uploads` | `content-type: application/octet-stream`；query `threadId` 或 `scope`（二选一）、`name?`、`imageMediaType?` | `threadId` → `sessions.uploadFile(threadId, …)`（复用归属与 Subagent 校验）；`scope` → `files.upload("peer-upload:" + scope, …)` | 200 + `remotePeerUploadResultSchema` envelope；415 非 octet-stream；400 参数缺失/冲突/scope 格式错 |
| `POST /api/peer/v1/prompt` | JSON `remotePeerPromptParamsSchema` | 有 `scope` 先 `files.bind("peer-upload:" + scope, threadId)`（幂等）；再 `rpc.dispatch("session/prompt", { args: { request: { sessionId: threadId, requestId, mode, expectedTurnId, content } } })` | 200 + envelope（透传 RpcResult） |
| `GET\|HEAD /api/peer/v1/file` | query `threadId`、`path` | 相对路径以 `localWorkspaceRoot(threadId)` 为基准；`realpath` 后必须在该根目录内，或被 `files.reference` / `images.idForPath` 识别为 Web 附件存储；读取后必须识别为 png/jpeg/webp/gif，≤ 50 MiB | 200 图片字节；400 参数错；404 Thread 未知/不在根内/不存在/非图片（不区分原因）；413 超限 |

`peer-manifest.ts`：`peerEndpoint(..., options?: { attachments?: boolean })`，为 true 时 manifest 带 `capabilities: { attachments: 1 }`（远端启用了 `WebFiles` 与 `WebImages` 时由 main 传 true）。

### D9. Hub 侧（Track B，`packages/web-server/src/remote-peer-attachments.ts`）

```ts
type PeerEndpoint = Pick<PeerHostClient, "record" | "state" | "manifest">;
export class RemotePeerAttachments {
  supported(peer: PeerEndpoint | undefined): boolean; // state==="connected" && manifest?.capabilities?.attachments === 1
  upload(peer: PeerEndpoint, target: { threadId: string } | { scope: string },
         chunks: AsyncIterable<Uint8Array>, name?: string, imageMediaType?: string): Promise<{ receiptId: string; file: WebFileRef }>;
  prompt(peer: PeerEndpoint, params: RemotePeerPromptParams): Promise<{ accepted: true }>;
  projector(threadId: string): { projectInput(content: unknown[]): unknown[]; projectImage(path: string, key: string): unknown };
  readAttachment(peer: PeerEndpoint, view: ChThreadView, threadId: string, attachmentId: string): Promise<{ attachment: unknown; data: string }>;
  serveFile(peer: PeerEndpoint, threadId: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<void>;
}
```

- `upload` 以 `peerFetch(..., { duplex: "half", body: ReadableStream })` 流式转发，不在本机落盘；远端 `ok:false` 原样转成 `RpcError(code, message, details)`。
- `projector` 只做占位投影：原生图片/`imageView` → `{ type: "image", attachment: { attachmentId: "peer-image:…", name, mediaType: "image/png", bytes: 0, width: 64, height: 64 } }`；原生文件 → 现有 `file` 引用形态（`nativePath` 仅展示）。**绝不读取本机文件**。
- `readAttachment` 先确认 `attachmentId` 出现在该视图已投影的用户消息或 Assistant 图片中并反查原生路径，再经远端 `/api/peer/v1/file` 取字节，用 `inspectImage(bytes)` 生成真实元数据；不匹配 → `session/attachment-not-found`。
- `serveFile` 只透传状态码与图片字节，响应头由本机设置：`Content-Type`（仅 `image/*`）、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`。

### D10. 附件提交策略（已拍板）

- **已有 Peer Thread**：浏览器选中附件即上传 → Hub `upload(peer, { threadId })` → 远端凭证归属该 Thread。任何含 `file` 部分的提交（任意 mode）统一走 `prompt(peer, { threadId, requestId, mode, expectedTurnId, content })`，由远端 `ChSessions` 按 mode 执行 start/queue/steer；浏览器的 `sendWhenIdle` 丢弃。纯文本提交保持现有 `deliverRemoteInput`/`prompt` 操作路径。
- **Hub 草稿**：`RemoteProjectDraft` 首次上传时惰性生成 `uploadScope = randomUUID()`，上传走 `{ scope }`。首条消息：先按现有流程 `startSelected` 创建并确认 Harness，再 `prompt(peer, { threadId, scope, … })`；远端先绑定再提交。若创建成功但提交失败，草稿已绑定到正式会话，浏览器重试时 Hub 对“由该草稿转正的会话”继续携带同一 `scope`（绑定幂等），凭证仍可解析。凭证 1 小时过期沿用 `WebFiles`。
- 只接受 `text` 与 `file` 部分；编码图片（`type: "image"`）对 Peer 会话拒绝为 `session/attachment-invalid`（reason `REMOTE_ENCODED_IMAGE_UNSUPPORTED`）。附件-only（无文字）允许。
- 能力门控：Peer 会话与 Peer 草稿的 `attachmentInput` = `{ enabled: true }` 且带 `imageLimits: WEB_IMAGE_LIMITS`，当且仅当 `supported(peer)`；否则 `{ enabled: false }`。`remoteHost` 投影增加 `filePreview: boolean`（同一条件）。Desktop 远程恒为 false。

### D11. 前端规则（Track C）

- 树：`threadTreeParentOf(summary, list)` 返回 `threadTreeParent`，当且仅当父行存在且两行的 `threadReference.hostId ?? "local"` 相同；删除对 `remoteHost` 的一刀切 null。`isLocalThreadTreeMember` 去掉 `!remoteHost` 条件（Desktop 远程行没有 `threadTreeParent` 投影，自然排除）。
- 图标：新增 `harnessIconSources(harnessId, hostId?)`（`ui-primitives`），`hostId` 以 `remote-peer:` 开头且 `harnessId !== "codex"` 时返回 Peer 图标与 presentation 路径（使用共享契约的路径函数），否则返回本机路径。`SessionHarnessIcon` 取行的 `remoteHost?.hostId`；`HarnessSelect` 经 `ModelSelectInjected.iconHostId` 获得（`ui-model-selection` 的 `inject(sessionId)` 从会话列表行读取）。
- 图片：`ChatView` 在 `remoteHost.hostId` 为 `remote-peer:` 且 `remoteHost.filePreview === true` 时，把原始路径解析为 `REMOTE_PEER_FILE_PROXY_PATH?sessionId=&path=`（不做本地 cwd 拼接）；其它远程仍不解析。
- `remoteHost` 投影类型（`tree.ts` 中的声明）增加 `filePreview?: boolean`。

### D12. 错误码

| 码 | 场景 |
| --- | --- |
| `remote/attachments-unsupported` | Peer 未声明能力、离线或 Desktop 远程会话收到上传/含文件提交/文件预览 |
| `remote/offline`、`remote/auth-error`、`remote/request-failed` | `peerFetch` 现有映射 |
| `session/attachment-invalid`（`FILE_NOT_STAGED`、`IMAGE_TOO_LARGE` 等） | 远端 envelope 透传 |
| `session/attachment-not-found` | 预览的 attachmentId 不在已加载视图中或远端 404 |
| `remote/read-failed` | 目录游标不前进或超过 100 页 |
| Hub `/api/remote-peer/file` | 非 `web-remote:`/非 Peer 会话、未知 Peer → 404；能力缺失 → 404；远端 4xx 状态透传，5xx/网络错误 → 502 |

### D13. 安全红线

1. 远端路径永不进入本机 `/api/file`、`ChAttachments`、`WebFileReferences`、终端、工作区文件下载或任何本机 `fs` 读取；Peer 视图与摘要的 `cwd` 恒为 `""`。
2. Hub 只请求 `record.origin` 下固定的 `/api/ch/v1/*` 与 `/api/peer/v1/*`，`redirect: "error"`，不抓取任意 URL；Access Token 不进入任何浏览器响应。
3. 远端文件端点只返回经校验的图片，按 `realpath` 判定根目录归属（拒绝符号链接逃逸），错误信息不回显路径。
4. 上传只接受 octet-stream，沿用本机图片大小限制与凭证过期；`scope` 必须是 UUID v4。
5. 新增 Hub 路由只接受解码后主机为 `remote-peer:` 的会话；`/api/peer/v1/*` 新路由沿用现有认证与同源闸门。
6. 本机 `ChHarnessCatalog` 与 Peer 目录互不共享缓存；Peer 目录事件不触发本机全局目录刷新。

## Risks / Trade-offs

- [`RemoteSessions` 已超 1300 行] → Peer 逻辑放进 `PeerThreadSource` 与 `RemotePeerAttachments`，门面只保留委托分支。
- [远端 Host 过旧缺少 catalog/tree 方法] → 按 `-32601` 回退到现状行为，不阻断列表。
- [事件流断开期间漏事件] → 依赖 `hello` 的 `reset` 与 `ChRealtime` 的重连全量失效；游标续传沿用现有 `epoch/after`。
- [草稿首条消息“已创建未提交”] → 与现有两步流程一致，靠 scope 幂等绑定支持重试。
- [图标 URL 缓存跨远端升级] → 沿用 `stale-while-revalidate`，最长一个缓存周期后更新。

## Migration

无持久化变化。Phase 1 对未升级远端兼容；Phase 2 只在两端都升级后由 manifest 自动开启。回滚任一端都会回到附件关闭或现有读路径。
