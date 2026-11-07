# Design

## Context

Relay 和电脑之间的协议在 [`add-remote-relay-server` 的 design](../2026-11-06-add-remote-relay-server/design.md) 中确定，本 change 实现电脑一侧，路径、请求头、签名内容、关闭码和窗口都按那里的约定，并从 `@codexhost/remote-relay/protocol` 导入，不另写一份。

现有 Web 是一个 `node:http` 服务，监听本机或局域网端口。`request-trust.ts` 根据直连地址和可信代理判断本机访问、客户端地址和 HTTPS；`auth.ts` 写登录 Cookie；`background-service.ts` 保存 `service.json` 中的启动选项。

## Decisions

### 模块和装配

- 新代码放在 `packages/web-server/src/remote-relay/`：身份密钥、控制连接（含代理和重连）、进程内 TLS、状态与 RPC 各一个模块。`main.ts` 只负责创建并把 HTTP 服务交给它。
- 电脑一侧是 HTTP/2 服务端，跑在 WebSocket 字节流上。收到 `POST /v1/register` 时用身份私钥签名作答，读到请求体中的主机名才算注册成功；收到 `POST /v1/tcp` 时立即回 200，把这个 stream 当作手机的 TCP 连接。
- 创建一个不调用 `listen()` 的 `tls.Server`（ALPN 只有 `http/1.1`，握手期限 10 秒），每个手机 stream 通过它的 `connection` 事件注入，`secureConnection` 后用 `server.emit("connection", socket)` 交给现有 HTTP 服务。直接 `new tls.TLSSocket()` 没有握手期限，发完 ClientHello 就停住的连接会一直占着 stream。HTTP/1.1 的 keep-alive、升级为 WebSocket 都沿用现有处理。
- 正常 EOF 不销毁 socket，WebSocket 关闭时销毁承载它的 Duplex。

### 请求归属

- 经中转的 TLS socket 记录在一个 `WeakMap<Socket, 手机地址>` 中，地址来自 stream 请求头 `relay-client-address`。`RequestTrust` 先查这个表：命中时 `secure()` 为真，`clientAddress()` 返回该地址，不读任何 `x-forwarded-*`；`isLocalConnection()` 本来就因远端地址不是回环而为假，不需要改。
- 经中转的请求，同源校验要求 `Origin` 完整等于 `https://<注册得到的主机名>`（协议和主机都比较），不再只比较主机部分。其他入口的校验不变。
- 经中转的 HTTPS 响应带 `Strict-Transport-Security: max-age=31536000`，不带 `includeSubDomains`，只约束这台电脑自己的子域。
- 所有入口的 HTML 响应带 `Content-Security-Policy: frame-ancestors 'self'`。加入 Public Suffix List 之前，同一中转域名下的兄弟子域是 same-site，可以带着用户的 Cookie 把界面嵌进自己的页面诱导点击；`__Host-` 防的是 Cookie 被覆盖，防不了嵌入。目前没有跨来源嵌入 Web 的场景，所以对所有入口一律加。

### Cookie 名

- `auth.ts` 按 `secure()` 选择名字：HTTPS 用 `__Host-codexhost_token`，HTTP 用 `codexhost_token`，读取时只认当前协议对应的名字。不兼容旧名：已通过 HTTPS 登录的浏览器升级后重新登录一次，换来不保留过渡代码。

### 身份密钥和证书文件

- 数据目录下的 `remote-relay/`：`identity.pem`（Ed25519 PKCS#8，权限 0600）、`certificate.pem` 和 `certificate-key.pem`。后两个由 `add-web-remote-certificates` 写入。
- 证书在开启中转时读取一次；读不到时状态为缺少证书，手机 stream 直接重置。第三个 change 写入或续期后调用本模块的重新加载入口，不轮询文件。

### 设置

- `--relay <控制地址>` 保存在 `service.json` 的 `relayHost`，和 `--public-url` 一样传空值清除。修改它与其他启动选项相同，会让后台 Web 以设置变更退出码重启。
- 开关保存在 `service.json` 的 `relayEnabled`，由新的 RPC `codexhost/relaySet` 修改，要求本机访问，直接启停连接，不触发重启。

### 连接、代理和重连

- 认证关闭（`--no-auth`）时拒绝开启中转：启动时即使 `relayEnabled` 为真也不连接，`codexhost/relaySet` 返回错误。否则电脑的全部能力会直接暴露到公网。
- 连接 `wss://<控制地址>/v1/agent`。签名中的控制地址用本地配置值的小写主机名。WebSocket 单条消息上限 1 MiB。`HTTPS_PROXY`（或 `https_proxy`）是 `http://` 地址时，先对代理发 `CONNECT <控制地址>:443`，在得到的 socket 上做 TLS 和 WebSocket 升级；证书校验和 SNI 都用控制地址。
- 退避：首次 1 秒，每次翻倍，上限 60 秒，每次取上限值的 50%–100% 之间的随机值。注册成功并保持 60 秒后，下一次断线从 1 秒重新开始。
- 一次连接尝试（DNS、代理 CONNECT、TLS、WebSocket 升级到注册完成）总期限 30 秒，超时销毁本次资源后进入退避。
- 60 秒内没有收到 WebSocket ping 就强制断开（`terminate()`）并重连（Relay 每 25 秒发一次）。
- 关闭码 4409（被替换）、4401（签名被拒）以及升级时的 404（版本不支持）进入“已停止”，不再重连，直到用户重新打开开关或 Web 重启。4408（注册超时）和其他断开按退避重连。

### 流控

- HTTP/2 服务端的 stream 窗口（`settings.initialWindowSize`）设为 2 MiB，会话连接窗口（`session.setLocalWindowSize`）设为 8 MiB，与 Relay 一致。依据和内存上限见 Relay 的 design。

### 状态

- `@codexhost/shared-contracts` 增加中转状态类型：`off`、`connecting`、`connected`（含地址）、`missing-certificate`（含地址）、`stopped`（含原因：`replaced`、`rejected`、`unsupported-version`）。连接设备页通过 RPC 读取，开关后刷新。

## Risks / Trade-offs

- [单独完成本 change 时真手机不可用] → 证书在第三个 change；本 change 的验收用测试 CA 和本机 Relay 完成端到端测试。
- [HTTPS 登录的浏览器升级后需重新登录一次] → 接受，在发行说明中写明。
- [不支持 `NO_PROXY`、SOCKS 代理和需要认证的代理] → 系统代理多为本机 HTTP 代理；遇到需要时再扩展。
- 所有手机连接都经一条控制连接，底层 TCP 丢包可能同时影响多个 HTTP/2 stream。

## Migration

新增设置项默认关闭，不配置 `--relay` 时行为与现在相同。Cookie 改名使 HTTPS 入口的现有登录失效一次。回滚：关闭开关或清除 `--relay`。
