# 多远端主机聚合（Peer Hub）

`codexhost web` 支持在同一个 Web / 桌面壳界面内连接并聚合多台运行 `codexhost web` 的远端主机（Peer），让用户在一个统一侧栏与新建会话入口中查看、发起和续跑多台机器上的会话，无需在浏览器标签页之间切换，也不依赖官方 Codex Desktop 的 SSH 连接。

## 架构与命名空间

- **命名空间隔离**：Peer 聚合主机使用 `remote-peer:<peerId>` 作为 `hostId`，与 Codex Desktop 现有的 `remote-ssh*` / `remote-control:*` 远程主机完全隔离。两类远程主机通过 `createCompositeRemoteCall` 并存，Codex Desktop 未启动时不影响 Peer 聚合。
- **单跳聚合、防环路**：被连接节点通过 `GET /api/peer/v1/manifest` 仅导出其本机非远端工作区（`!w.remote`），因此两台主机之间可以双向互连而不产生递归环路。
- **分层复用读路径与事件驱动同步**：每个启用的 Peer 由 `PeerChHostClient`（实现 `ChHostClient` 接口，底层走版本化 `/api/ch/v1/*`）与 `PeerThreadSource` 组合直连同款的 `ChRealtime`、`ChThreadHistory`（`hostThreadId` 隔离原生与展示 ID、`knownTurns` 指纹增量、首屏 5 个 Turn 与按需翻页）、`ChHarnessCatalog`（按节点与 epoch 隔离缓存，收到 `harness-inspection-changed` 或 `hello` 才失效）、`readSessionPage`（`codexhost/thread/catalog/read`，旧远端 `-32601` 时回退 `thread/list`）与 `ChThreadTree`（同节点委派树与归档级联，`tree/read` 失败时静默降级）。
  - 事件流直接驱动会话内容、用量与目录刷新，取消周期性全量轮询；流式文本与工具增量帧不触发目录刷新。
  - 为事件流读取设置 45 秒空闲读超时（服务端每 15 秒发送心跳换行），半开断连时自动中止并走指数退避重连。
- **节点作用域 Harness 图标**：本机新增 `GET /harness-icons/peer/<peerId>/<harnessId>` 与 `GET /harness-icons/peer/<peerId>/presentation.json`（从对应 Peer 缓存目录提供并设置 `Content-Security-Policy: sandbox; default-src 'none'`），Codex 始终使用本机图标，远端离线或缺失时退回通用图标。
- **同节点委派树**：侧栏按 `threadReference.hostId` 对同一 Peer 内的父子委派建树（含祖先补齐与归档级联），跨主机关系保持顶层平铺；Codex Desktop 远程会话保持原有兼容路径。

## 接口与持久化

### Peer 节点端点（`/api/peer/v1/*`）

所有端点受 `web-server` 既有认证（Bearer Token / Session Cookie）与同源校验保护；异常统一映射为安全的客户端错误信息，不透传宿主绝对路径或内部错误栈：

- `GET /api/peer/v1/manifest`：返回服务端版本、宿主实时通道真实 `epoch`（未就绪前返回 `503`）、平台、主机名、主目录、本机工作区清单，以及在启用附件存储时的 `capabilities: { attachments: 1 }`。
- `GET /api/peer/v1/dirs?path=...`：列出远端目录子文件夹（保留目录名中的空格；空参数回退到远端主目录）。
- `POST /api/peer/v1/dirs`：在指定父目录下创建新子目录。
- `POST | PATCH | DELETE /api/peer/v1/workspaces`：在远端节点新增、重命名或移除工作区注册，并返回最新 `manifest`。
- `POST /api/peer/v1/uploads`：接收 `application/octet-stream` 原始字节流（`threadId` 归属已有远端会话，`scope` 为 UUID v4 供草稿上传暂存），委托远端 `ChSessions.uploadFile` / `WebFiles.upload` 返回上传凭据。
- `POST /api/peer/v1/prompt`：接收带文件凭据的提交请求；携带 `scope` 时先幂等绑定凭据到目标 `threadId`，再转发远端 `session/prompt`。
- `GET | HEAD /api/peer/v1/file?threadId=...&path=...`：校验路径位于该会话工作目录（固定根目录与无符号链接组件校验）或远端 Web 附件存储内，并校验图片字节与 50 MiB 上限后返回图片内容；拒绝越界或非图片请求且不回显宿主路径。

### Hub 侧附件代理与安全边界

- **能力门控**：仅当 Peer 已连接且 `manifest.capabilities.attachments === 1` 时开启 Peer 会话与草稿的 `attachmentInput`、`imageLimits` 与 `remoteHost.filePreview`；未升级 Peer 与 Codex Desktop 远程会话保持附件关闭。
- **远端路径隔离**：浏览器图片预览走 `GET | HEAD /api/remote-peer/file?sessionId=...&path=...`（强制 `sandbox; default-src 'none'` 与 `nosniff`），上传流经 `/api/session/uploadFileBinary` 直接流式转发到远端，远端路径永不进入本机 `/api/file` 或本机文件系统读取。

### Hub 管理 RPC（`codexhost/remote-peers/*`）与安全边界

- **本地配置持久化**：保存在当前 `web-server` 数据目录（`--data` / `CODEXHOST_WEB_DATA`）下的 `remote-peers-v1.json`（POSIX 权限 `0600`）；读取时做 Schema 校验，文件损坏时记录告警并回退为空列表，不阻塞服务启动。Access Token 永远不会通过任何 list/summary RPC 返回给前端。
- **权限分级**：
  - `add`、`update`、`remove`、`test` 涉及修改 Peer 拓扑和触发服务端出站探测，仅允许本机已认证会话（`ctx.auth.local === true`）调用。
  - `list`、`reconnect`、`listDirs`、`createDir`、`createWorkspace`、`renameWorkspace`、`deleteWorkspace` 对所有已认证会话（含移动端与远程 Web）开放。
- **SSRF 防护**：默认拒绝回连本机回环地址（`localhost`、`127.0.0.0/8`、`[::1]`）、未指定地址（`0.0.0.0/8`、`::`）以及常见链路本地 / 云元数据地址（`169.254.0.0/16`、`fe80::/10`、`metadata.google.internal`、`metadata.goog`、`fd00:ec2::254`）；仅在显式配置 `CODEXHOST_ALLOW_LOOPBACK_PEERS=1`（本地双节点开发/测试）时放行回环地址。

## Web 界面入口

- **设置 → 远程访问**：提供「共享本机」与「远程主机」双标签，支持粘贴连接链接或手动填写地址/令牌、测试连接、编辑、重连与移除。
- **新建会话凹陷顶轨**：在空白会话输入框上方提供「工作位置 → 项目」两级搜索选择器，切换远端主机后按该主机过滤项目，并支持直接通过远程目录选择器新建远端项目；若未选项目直接关闭弹窗，自动恢复为当前会话实际所属主机。
- **侧栏主机筛选与会话标识**：工作区区头提供按主机与按工作区子集的持久化筛选器；从全局搜索打开位于筛选范围外的远端会话时自动放宽筛选使其可见。已开始的远端会话在输入框底栏显示只读主机与工作区标识，断连时展示内联重连条。
