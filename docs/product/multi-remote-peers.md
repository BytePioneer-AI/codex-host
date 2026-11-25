# 多远端主机聚合（Peer Hub）

`codexhost web` 支持在同一个 Web / 桌面壳界面内连接并聚合多台运行 `codexhost web` 的远端主机（Peer），让用户在一个统一侧栏与新建会话入口中查看、发起和续跑多台机器上的会话，无需在浏览器标签页之间切换，也不依赖官方 Codex Desktop 的 SSH 连接。

## 架构与命名空间

- **命名空间隔离**：Peer 聚合主机使用 `remote-peer:<peerId>` 作为 `hostId`，与 Codex Desktop 现有的 `remote-ssh*` / `remote-control:*` 远程主机完全隔离。两类远程主机通过 `createCompositeRemoteCall` 并存，Codex Desktop 未启动时不影响 Peer 聚合。
- **单跳聚合、防环路**：被连接节点通过 `GET /api/peer/v1/manifest` 仅导出其本机非远端工作区（`!w.remote`），因此两台主机之间可以双向互连而不产生递归环路。
- **分层复用读路径与事件驱动同步**：每个启用的 Peer 由 `PeerChHostClient`（实现 `ChHostClient` 接口，底层走版本化 `/api/ch/v1/*`）与 `PeerThreadSource` 组合直连同款的 `ChRealtime`、`ChThreadHistory`（`hostThreadId` 隔离原生与展示 ID、`knownTurns` 指纹增量、首屏 5 个 Turn 与按需翻页）、`ChInteractions`（统一承接同步/异步提问、外部 Harness 审批、原生审批动作与 `nativeInteractionError` 投影，断线或换代时及时清理）、`ChHarnessCatalog`（按节点与 epoch 隔离缓存，收到 `harness-inspection-changed` 或 `hello` 才失效）、`readSessionPage`（`codexhost/thread/catalog/read`，旧远端 `-32601` 时回退 `thread/list`）与 `ChThreadTree`（同节点委派树与归档级联，`tree/read` 失败时静默降级）；同时支持远端会话 `codexhost/turnDiffs`、`session/search` 全局搜索合流与 `thread://<id>?hostId=remote-peer:...` 引用跳转。
  - 事件流直接驱动会话内容、用量与目录刷新，取消周期性全量轮询；流式文本与工具增量帧不触发目录刷新。
  - 为事件流读取设置 45 秒空闲读超时（服务端每 15 秒发送心跳换行），半开断连时自动中止并走指数退避重连。
- **节点作用域 Harness 图标**：本机新增 `GET /harness-icons/peer/<peerId>/<harnessId>` 与 `GET /harness-icons/peer/<peerId>/presentation.json`（从对应 Peer 缓存目录提供并设置 `Content-Security-Policy: sandbox; default-src 'none'`），Codex 始终使用本机图标，远端离线或缺失时退回通用图标。
- **同节点委派树**：侧栏按 `threadReference.hostId` 对同一 Peer 内的父子委派建树（含祖先补齐与归档级联），跨主机关系保持顶层平铺；Codex Desktop 远程会话保持原有兼容路径。

## 接口与持久化

### Peer 节点端点（`/api/peer/v1/*`）

所有端点受 `web-server` 既有认证（Bearer Token / Session Cookie）与同源校验保护；异常统一映射为安全的客户端错误信息，不透传宿主绝对路径或内部错误栈：

- `GET /api/peer/v1/manifest`：返回服务端版本、宿主实时通道真实 `epoch`（未就绪前返回 `503`）、平台、主机名、主目录、本机工作区清单，以及按实际可用性声明的 `capabilities`（如 `attachments: 1`、`workspaceFiles: 1`、`officePreview: 1`、`delegation: 1`；其中 `delegation: 1` 仅在底层 Host Runtime 支持且未设置 `CODEXHOST_DISABLE_PEER_DELEGATION=1` 时声明）。
- `GET /api/peer/v1/dirs?path=...`：列出远端目录子文件夹（保留目录名中的空格；空参数回退到远端主目录）。
- `POST /api/peer/v1/dirs`：在指定父目录下创建新子目录。
- `POST | PATCH | DELETE /api/peer/v1/workspaces`：在远端节点新增、重命名或移除工作区注册，并返回最新 `manifest`。
- `POST /api/peer/v1/uploads`：接收 `application/octet-stream` 原始字节流（`threadId` 归属已有远端会话，`scope` 为 UUID v4 供草稿上传暂存），委托远端 `ChSessions.uploadFile` / `WebFiles.upload` 返回上传凭据。
- `POST /api/peer/v1/prompt`：接收带文件凭据的提交请求；携带 `scope` 时先幂等绑定凭据到目标 `threadId`，再转发远端 `session/prompt`。
- `GET | HEAD /api/peer/v1/file?threadId=...&path=...`：校验路径位于该会话工作目录（固定根目录与无符号链接组件校验）或远端 Web 附件存储内，并校验图片字节与 50 MiB 上限后返回图片内容；拒绝越界或非图片请求且不回显宿主路径。
- `POST /api/peer/v1/workspace-files/rpc`：只读白名单端点，仅放行 `workspaceFiles/read`、`workspaceFiles/readBytes`、`workspaceFiles/stat`、`workspaceFiles/list` 与 `officeToPdf/render`；所有文件访问均经统一受限文件访问层（`O_NOFOLLOW`、`realpath` 与 `dev/ino` 二次校验）直接执行实际 I/O，拒绝工作区外路径、控制字符/NUL、UNC、`..` 越界与符号链接 TOCTOU 逃逸；`officeToPdf/render` 通过同一受限句柄读取字节（50 MiB 上限）送入本地 `OfficeToPdf` 转换引擎，不向 DSH 回传裸路径字符串；入口即绑定连接取消信号并透传至工作区解析、文件读取与 Office 转换。
- `GET | HEAD /api/peer/v1/workspace-files/download?threadId=...&path=...`：经同一受限文件描述符访问层流式传输原文件（不受 `readBytes` 32 MiB 限制），客户端断开时立即关闭文件句柄。
- `POST /api/peer/v1/delegation`：跨机委派白名单端点，仅接受 `read`、`send`、`cancel`、`answer`、`start`、`threadList`、`harnessList`、`harnessInspect` 及 `hopCount === 1` 请求，支持在远端本地创建 `--worktree` / `--base` 并结合 `requestId` 持久幂等与 worktree 归属核验；可通过 `CODEXHOST_DISABLE_PEER_DELEGATION=1` 关闭；`/api/ch/v1/rpc` 拒绝直接调用内部 `codexhost/peer/delegation` 方法。

### 跨机委派与本机私有桥接

- **本机私有回环桥接**：运行 Peer Hub 的每个 `web-server` 实例在 Host 数据目录 `peer-delegation-bridges/` 下写入各自独立的 `0600` 描述文件，并在退出时仅清理自身文件，避免多实例并发覆盖或误删。桥接仅监听回环地址 `127.0.0.1`，强制 64 字符 Bearer Token 鉴权、拒绝任意 `Origin` 请求头并限制 2 MiB 请求体；转发失败时写操作不自动重试，且对远端错误信封执行独立二次脱敏与凭据擦除（日志仅输出白名单归一化错误码）。
- **跨机发现与操作范围**：本机 CLI（`codexhost host list` 以及各委派与 Thread 命令的 `--host remote-peer:<peerId>` / `thread://<id>?hostId=...`）、控制 HTTP 路由与 MCP（`host_list` 与各 Thread 工具）支持对已声明 `capabilities.delegation: 1` 的 Peer 执行跨机发现、读取、发送（含 `steer`/`interrupt`）、取消、答题、发起委派（远端本地 worktree）与受总期限约束的分段轮询 `wait`。所有返回链接与提示均保留 `hostId`；远端失败绝不回退本机，且不向远端转发 `callerThreadId`。
- **一跳防环路与边界**：在同 OS 用户（同 UID）信任边界内，远端 Peer 委派创建的 Thread 及其本机后代严格限制为 1 跳（外部 Harness 使用每 Thread HMAC 绑定令牌；原生 Codex 使用仅限活跃原生 Thread 的共享令牌并配合持久化祖先链，祖先查询异常或超深时 fail-closed 拒绝）。跨机 `watch`、`export`、`file` 与远端 `start`/`send` 的 `--watch true` 均明确拒绝；Codex Desktop 的 `remote-ssh*` / `remote-control:*` 主机保持原有只读 `thread read` 兼容。

### Hub 侧附件、工作区文件代理与安全边界

- **能力门控**：
  - 仅当 Peer 已连接且 `manifest.capabilities.attachments === 1` 时开启 Peer 会话与草稿的 `attachmentInput`、`imageLimits` 与 `remoteHost.filePreview`。
  - 仅当 Peer 已连接且 `manifest.capabilities.workspaceFiles === 1`（Office 转换另需 `officePreview === 1`）时放行远端工作区文件预览与下载，并在 `remoteHost` 上分别投影 `workspaceFiles` 与 `officePreview`（前端文件预览面板与文件侧栏在发请求前即按该能力门控，远端会话同时禁用 `@` 文件补全）；旧版 Peer、未提交草稿、离线/禁用 Peer 以及 Codex Desktop 远程会话均返回明确提示，绝不回落到 Hub 本机路径，也不会为读文件创建远端 Thread。
- **远端路径与渲染隔离**：
  - 浏览器图片预览走 `GET | HEAD /api/remote-peer/file?sessionId=...&path=...`（强制 `sandbox; default-src 'none'` 与 `nosniff`），上传流经 `/api/session/uploadFileBinary` 直接流式转发到远端，远端路径永不进入本机 `/api/file` 或本机文件系统读取。
  - Hub 拦截远程会话的 `workspaceFiles/*`、`officeToPdf/render`（独立 65s 长超时、JSON 8 MiB 响应上限、上游 `rpcId` 一致性校验、单 Peer / 全局并发限流、流空闲超时与 `AbortSignal` 取消透传）及 `/api/workspace-file/download`、`/api/workspace-file/download-ticket`（签发期 `HEAD` 校验同样绑定浏览器取消信号，ticket 仅绑定 `{ sessionId, path }`、不含 Peer Token，并在实际下载时重验 Peer 状态）；WebSocket `workspaceFiles/changes` 对远程会话返回 `workspace-file/watch-unsupported`，由前端自动降级为静态 `stat` / 手动刷新。
  - 前端 Office 预览对远程会话跳过 Hub 本机 `officeToPdf/generation` 与跨次打开持久化缓存（仅保留同路径并发去重并彻底隔离本机 `local` 缓存），避免 Peer 重启或字体变更后命中旧 PDF；远程会话隐藏「在主机默认应用中打开」「打开所在文件夹」等本机打开入口，且服务端 `session/openWorkspacePath` 强制要求并校验已注册的真实本机会话，拒绝缺失、未知或远程 `sessionId`。

### Hub 管理 RPC（`codexhost/remote-peers/*`）与安全边界

- **本地配置持久化**：保存在当前 `web-server` 数据目录（`--data` / `CODEXHOST_WEB_DATA`）下的 `remote-peers-v1.json`（POSIX 权限 `0600`）；读取时做 Schema 校验，文件损坏时记录告警并回退为空列表，不阻塞服务启动。Access Token 永远不会通过任何 list/summary RPC 返回给前端。
- **权限分级**：
  - `add`、`update`、`remove`、`test` 涉及修改 Peer 拓扑和触发服务端出站探测，仅允许本机已认证会话（`ctx.auth.local === true`）调用。
  - `list`、`reconnect`、`listDirs`、`createDir`、`createWorkspace`、`renameWorkspace`、`deleteWorkspace` 对所有已认证会话（含移动端与远程 Web）开放。
- **SSRF 防护**：默认拒绝回连本机回环地址（`localhost`、`127.0.0.0/8`、`[::1]`）、未指定地址（`0.0.0.0/8`、`::`）以及常见链路本地 / 云元数据地址（`169.254.0.0/16`、`fe80::/10`、`metadata.google.internal`、`metadata.goog`、`fd00:ec2::254`）；仅在显式配置 `CODEXHOST_ALLOW_LOOPBACK_PEERS=1`（本地双节点开发/测试）时放行回环地址。

## Web 界面入口

- **设置 → 远程访问**：提供「共享本机」与「远程主机」双标签，支持粘贴连接链接或手动填写地址/令牌、测试连接、编辑、重连与移除。
- **新建会话凹陷顶轨**：在空白会话输入框上方提供「工作位置 → 项目」两级搜索选择器，切换远端主机后按该主机过滤项目，并支持直接通过远程目录选择器新建远端项目；若未选项目直接关闭弹窗，自动恢复为当前会话实际所属主机。
- **侧栏主机筛选、跨主机工作区排序与会话标识**：工作区区头提供按主机与按工作区子集的持久化筛选器；从全局搜索打开位于筛选范围外的远端会话时自动放宽筛选使其可见。侧栏顶层工作区支持跨本机与多个远端主机自由拖拽混排，统一保存在当前 Hub 的 `workspaces.json`（`displayOrder`）而不修改远端节点配置；Peer 断线或禁用时保留原槽位，重连后自动归位，仅在永久移除 Peer 时清理。已开始的远端会话在输入框底栏显示只读主机与工作区标识，断连时展示内联重连条。
