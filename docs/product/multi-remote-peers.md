# 多远端主机聚合（Peer Hub）

`codexhost web` 支持在同一个 Web / 桌面壳界面内连接并聚合多台运行 `codexhost web` 的远端主机（Peer），让用户在一个统一侧栏与新建会话入口中查看、发起和续跑多台机器上的会话，无需在浏览器标签页之间切换，也不依赖官方 Codex Desktop 的 SSH 连接。

## 架构与命名空间

- **命名空间隔离**：Peer 聚合主机使用 `remote-peer:<peerId>` 作为 `hostId`，与 Codex Desktop 现有的 `remote-ssh*` / `remote-control:*` 远程主机完全隔离。两类远程主机通过 `createCompositeRemoteCall` 并存，Codex Desktop 未启动时不影响 Peer 聚合。
- **单跳聚合、防环路**：被连接节点通过 `GET /api/peer/v1/manifest` 仅导出其本机非远端工作区（`!w.remote`），因此两台主机之间可以双向互连而不产生递归环路。
- **事件流与按主机增量刷新**：Hub 侧每个 Peer 维护独立状态机（`connected` / `connecting` / `offline` / `auth-error` / `disabled`），订阅远端 `/api/ch/v1/events` NDJSON 流：
  - 仅在 `hello` 或影响会话目录/状态的变更事件（如 `thread/*`、`turn/started`、`turn/completed`）到达时按 `hostId` 触发目标主机目录刷新，忽略流式文本/工具增量帧。
  - 为事件流读取设置 45 秒空闲读超时（服务端每 15 秒发送心跳换行），半开断连时自动中止并走指数退避重连。

## 接口与持久化

### Peer 节点端点（`/api/peer/v1/*`）

所有端点受 `web-server` 既有认证（Bearer Token / Session Cookie）与同源校验保护；异常统一映射为安全的客户端错误信息，不透传宿主绝对路径或内部错误栈：

- `GET /api/peer/v1/manifest`：返回服务端版本、宿主实时通道真实 `epoch`（未就绪前返回 `503`）、平台、主机名、主目录和本机工作区清单。
- `GET /api/peer/v1/dirs?path=...`：列出远端目录子文件夹（保留目录名中的空格；空参数回退到远端主目录）。
- `POST /api/peer/v1/dirs`：在指定父目录下创建新子目录。
- `POST | PATCH | DELETE /api/peer/v1/workspaces`：在远端节点新增、重命名或移除工作区注册，并返回最新 `manifest`。

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
