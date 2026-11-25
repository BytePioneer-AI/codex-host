# Tasks

> 并行规则：Track 0 先合入；随后 A、B、C 三个 Track 并行，文件所有权互不重叠；D 在 A 与 B 合入后执行。契约以 `design.md` D2–D13 为准，实现中如需改契约先回报主导者。每个 Track 只跑自己列出的测试文件；跨包改动后 `npx tsc -b packages/<pkg>`。

## 0. Track 0：公共契约（先合入，单人）

文件：`packages/shared-contracts/src/remote-peers.ts`、`packages/web-server/src/peer-host-client.ts`（仅抽取 `peerFetch`）

- [x] 0.1 按 D7 增加 `remotePeerCapabilitiesSchema`、manifest `capabilities`、`REMOTE_PEER_UPLOAD_SCOPE_PATTERN`、`REMOTE_PEER_FILE_PROXY_PATH`、`remotePeerHarnessIconPath`、`remotePeerHarnessPresentationPath`、`remotePeerPromptParamsSchema`、上传与发送结果 envelope schema 及类型导出。验证：`npx tsc -b packages/shared-contracts`；旧 manifest（无 `capabilities`）仍能解析。
- [x] 0.2 按 D2 把 `PeerHostClient` 私有 `fetch` 抽成导出的 `peerFetch(record, path, init)`（支持流式 body 与 `duplex`），`PeerHostClient` 改为调用它，行为不变。验证：`npx vitest run --config tests/vitest.config.js packages/web-server/test/peer-host-manager.test.ts` 通过；`npx tsc -b packages/web-server`。

## 1. Track A：Peer 读路径分层复用（依赖 Track 0）

文件（独占）：新建 `packages/web-server/src/peer-ch-host-client.ts`、`packages/web-server/src/peer-thread-source.ts`；修改 `peer-host-client.ts`、`peer-host-manager.ts`、`ch-thread-history.ts`、`remote-sessions.ts`、`remote-project-draft.ts`、`remote-session-controls.ts`、`main.ts`（仅图标路由与 `RemoteSessions` 构造参数）、`docs/product/multi-remote-peers.md`。测试：新建 `test/peer-ch-host-client.test.ts`、`test/peer-thread-source.test.ts`；扩展 `test/peer-host-manager.test.ts`、`test/remote-sessions.test.ts`、`test/ch-thread-history.test.ts`。

- [x] 1.1 实现 `PeerChHostClient` 与 `PeerHostClient` 的事件分发（D2 事件规则），删除 `isCatalogChangingEvent` 目录刷新。验证：`peer-ch-host-client.test.ts` 用本地假 HTTP 服务覆盖 rpc/snapshot/respond 往返、坏行丢弃、late subscriber 收到 connection+hello、断流发 `online:false`。
- [x] 1.2 `ChThreadHistory` 增加 `hostThreadId` 选项（D4）。验证：`ch-thread-history.test.ts` 新增用例断言 Host 请求使用原生 ID、视图 `thread.id`/`cwd` 保持展示值；原有用例不变。
- [x] 1.3 实现 `PeerThreadSource`（D3）及 `PeerHostManager` 的创建、关闭、`client(hostId)`、`source(hostId)`。验证：`peer-thread-source.test.ts` 覆盖 catalog/read 多页与 100 页上限、`-32601` 回退 `thread/list`、tree/read 失败时 `parents={}`、`hello` 后目录缓存失效；`peer-host-manager.test.ts` 覆盖重装/移除时 source 关闭。
- [x] 1.4 `RemoteSessions` 与 `RemoteProjectDraft` 接入 Peer 读路径（D5、D6）：列表、摘要 `harnessIdentity`/`threadTreeParent`、读取与事件驱动跟随、翻页、控制、草稿目录、归档级联；删除 `PeerHostClient.call` 无调用方分支；Desktop 远程路径不变。验证：`remote-sessions.test.ts` 新增 Peer 用例（无轮询仍收到新回合、首屏只读一页、树父 ID 映射、跨主机父为 null、归档级联、Desktop 远程用例保持通过）。
- [x] 1.5 `main.ts` 增加 `/harness-icons/peer/<peerId>/<id>` 与 `/harness-icons/peer/<peerId>/presentation.json`（来自对应 source 的 `catalog`，未知/离线 404），并把 manager 传给 `RemoteSessions`；更新 `docs/product/multi-remote-peers.md` 的读路径与图标说明。验证：`remote-sessions.test.ts` 或新用例断言图标来自 Peer 目录且不调用本机目录；文档描述与实现一致。

## 2. Track B：Peer 附件上传与图片代理模块（依赖 Track 0，与 A 并行）

文件（独占）：新建 `packages/web-server/src/peer-attachments-http.ts`、`packages/web-server/src/remote-peer-attachments.ts`；修改 `packages/web-server/src/peer-manifest.ts`。测试：新建 `test/peer-attachments-http.test.ts`、`test/remote-peer-attachments.test.ts`。不改 `main.ts`、`remote-sessions.ts`、`remote-project-draft.ts`。

- [x] 2.1 远端端点 `servePeerAttachments`（D8）与 manifest `capabilities` 选项。验证：`peer-attachments-http.test.ts` 用真实 `WebFiles`/`WebImages`（临时数据目录）与假 `ChSessions`/`RpcRegistry` 覆盖：threadId 上传委托 `uploadFile`、scope 上传与 prompt 绑定后凭证可解析、scope 格式错 400、非 octet-stream 415、文件读取根内图片 200、根外/符号链接逃逸/非图片 404、超限 413、manifest 仅在选项开启时带 `capabilities.attachments=1`。
- [x] 2.2 Hub 侧 `RemotePeerAttachments`（D9、D10、D12）：`supported`、流式 `upload`、`prompt`、占位 `projector`、`readAttachment`、`serveFile`。验证：`remote-peer-attachments.test.ts` 用本地假 Peer HTTP 服务覆盖：上传流式转发与错误 envelope 映射、能力缺失抛 `remote/attachments-unsupported`、projector 不触碰本机文件系统（对存在于本机的同名路径也只产生占位）、`readAttachment` 拒绝视图外 attachmentId、`serveFile` 只透传图片并设置安全响应头。

## 3. Track C：Web UI 适配（依赖 Track 0，与 A、B 并行）

文件（独占）：`apps/web-ui/packages/client/ui-workspace/src/client/tree.ts`、`ui-workspace/src/client/thread-tree-catalog.ts`、新建 `ui-primitives/src/harness-icon-sources.ts` 并在 `ui-primitives/src/index.ts` 导出、`ui-codexhost/src/client/SessionHarnessIcon.tsx`、`ui-model-selection/src/client/HarnessSelect.tsx`、`ui-model-selection/src/client/ModelControls.tsx`、`ui-model-selection/src/client/slots.ts`、`ui-model-selection/src/client/index.ts`、`ui-chat/src/client/chat/ChatView.tsx`（路径均相对 `apps/web-ui/packages/client/`）。测试：扩展 `ui-workspace/test/thread-tree.test.ts`（纯函数测试，不写组件测试）。

- [x] 3.1 树同节点规则（D11）：`threadTreeParentOf` 与 `isLocalThreadTreeMember` 改为按 `threadReference.hostId` 判断，`remoteHost` 投影类型加 `filePreview?`。验证：`thread-tree.test.ts` 新增同一 Peer 父子成树、跨主机父为 null、Desktop 远程行（无 `threadTreeParent`）不入树、本机用例不变。
- [x] 3.2 Peer 图标与图片预览地址（D11）：`harnessIconSources`、`SessionHarnessIcon`、`HarnessSelect` 经 `iconHostId`、`ChatView` 的 Peer 图片代理地址。验证：相关包 `npx tsc -b` 通过；在 PR 中附隔离环境截图展示 Peer 会话图标与图片预览（无 Peer 能力时附件按钮禁用）。

## 4. Track D：集成（A 与 B 合入后，单人）

文件：`packages/web-server/src/remote-sessions.ts`、`packages/web-server/src/remote-project-draft.ts`、`packages/web-server/src/main.ts`、`docs/product/multi-remote-peers.md`。测试：新建 `test/remote-peer-attachment-flow.test.ts`。

- [x] 4.1 远端接线：`main.ts` 在 `/api/peer/v1/` JSON 解析前分流 `uploads|prompt|file` 到 `servePeerAttachments`，`peerEndpoint` 在本机启用文件与图片输入时传 `attachments: true`。验证：`remote-peer-attachment-flow.test.ts` 以两个 Web 实例或假 Hub 调用真实远端路由完成上传→发送。
- [x] 4.2 Hub 接线（D10）：`attachmentInput`/`imageLimits`/`remoteHost.filePreview` 门控投影；上传入口按 `web-remote:` 分派到 `RemoteSessions.uploadFile`（草稿惰性 `uploadScope`）；含文件提交（已有会话与草稿首条、失败后重试携带 scope）走 `prompt`；Peer 会话的 `session/attachment` 走 `readAttachment`；Peer 视图传入 `projector`；新增 `GET|HEAD /api/remote-peer/file`。验证：`remote-peer-attachment-flow.test.ts` 覆盖已有会话发图、草稿首条带文件、创建后提交失败再重试、能力缺失时附件关闭、Desktop 远程会话收到上传被拒；更新 `docs/product/multi-remote-peers.md` 的附件与安全说明。
