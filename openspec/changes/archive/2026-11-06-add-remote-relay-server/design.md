# Design

## Context

Relay 按 SNI 转发 TLS 字节，通过反向 HTTP/2 复用手机连接，并将 TLS-ALPN-01 验证连接转发到电脑。本文定义 Relay 与电脑端之间的协议；电脑端由 `add-web-remote-relay-client` 实现。

## Decisions

### 身份和子域 ID

- 身份密钥用 Ed25519。
- ID 取公钥原始 32 字节的 SHA-256 前 16 字节（128 位），用小写 RFC 4648 base32 编码、不带填充，得到 26 个字符。地址发布后无法再加长，所以一开始就留足余量：80 位时伪造指定 ID 约需 2^80 次运算，余量偏薄；Syncthing 和 Tor v3 也都保留完整长度的公钥派生。用户通过链接或二维码打开地址，长度不影响使用。
- SNI 先与控制地址比较，再按 `<id>.<域名>` 解析，不区分大小写。控制地址即使恰好是 ID 的形式也不会被路由到电脑。

### 控制连接和注册

- 电脑连接 `wss://<控制地址>/v1/agent`。路径带协议版本：Relay 对不认识的路径返回 404，不升级。控制地址的 TLS 只提供 `http/1.1`，WebSocket 关闭 permessage-deflate（载荷是加密数据，压缩无效）。
- 升级完成后，WebSocket 二进制消息承载一条字节流，在其上运行明文 HTTP/2（prior knowledge）。Relay 是客户端，电脑是服务端。
- 注册在 HTTP/2 内完成，不另设消息格式：
  1. Relay 发送 `POST /v1/register`，请求头 `relay-challenge` 为 32 字节随机数的 base64url。
  2. 电脑返回 200，响应头 `relay-public-key`（公钥原始字节的 base64url）和 `relay-signature`（签名的 base64url）。签名内容为 UTF-8 字符串 `codexhost-relay-register-v1\n<控制地址>\n<challenge>`。签名绑定控制地址，所以一个 Relay 拿不到能在别的 Relay 上用的签名。
  3. Relay 验签、计算 ID、替换同 ID 的旧连接后，在请求体写入 `{"hostname":"<id>.<域名>"}` 并结束请求。电脑收到它才算注册成功，再开始申请证书。
- 失败时 Relay 用 WebSocket 关闭码告知原因：4401 签名无效，4408 注册超时（10 秒），4409 被同一 ID 的新连接替换。电脑端据此决定是否重试。
- 两端按同一规则解释注册：
  - 签名中的控制地址是小写主机名，不带端口和末尾的点。电脑用自己配置的值签名，不用 Relay 告诉它的值。
  - 每条控制连接只发一次挑战，验证一次后作废。
  - 公钥解码后必须是 32 字节，签名 64 字节，挑战 32 字节；字段重复或编码不符即拒绝。
  - 注册完成前 Relay 不打开 `/v1/tcp`；电脑拒绝第二次注册和未知路径。
- WebSocket 单条消息上限 1 MiB（两端都设置 `maxPayload`）。HTTP/2 帧远小于这个值，正常流量不会触及；它防止在 HTTP/2 流控生效前，一条超大消息先占用内存。

### 手机连接

- 每条手机连接对应一个 `POST /v1/tcp` 请求，请求头 `relay-client-address` 和 `relay-client-port` 是手机的 IP 和端口。请求体是手机发往电脑的字节，响应体是电脑发往手机的字节。电脑立即返回 200。
- 一个方向的 `END_STREAM` 对应 TCP 在该方向的 FIN；`RST_STREAM` 或任一侧出错时，两侧都销毁。
- `POST /v1/tcp` 使用双向请求体和响应体承载全双工字节流。
- 手机 socket 开启 `noDelay` 和 TCP keepalive，避免已消失的手机连接长期占用 stream。
- 每个 ID 最多同时转发 32 条手机连接。这是固定值，不做配置：手机经中转只协商 HTTP/1.1，浏览器每个主机约 6 条连接，几台手机同时使用也在范围内。它同时决定了下面的内存上限。

### 流控

- 两端的 HTTP/2 都把 stream 窗口（`SETTINGS_INITIAL_WINDOW_SIZE`）设为 2 MiB，连接窗口设为 8 MiB。电脑端在 HTTP/2 服务端设相同值（电脑端 change）。
- 手机写入变慢时，Relay 停止读取对应 stream，该 stream 的窗口耗尽，电脑在这条 stream 上的发送随之阻塞。Node 收到数据时会立即补充连接窗口，所以连接窗口不限制总缓存，其他 stream 也因此不被阻塞。每台电脑在每个方向上被缓存的数据上限约为 32 × 2 MiB = 64 MiB，另加 1 MiB 的 WebSocket 消息。
- 较大的 stream 窗口用于支持高延迟链路上的传输。审批优先级由电脑上的 HTTP 服务决定，不在 Relay 层处理。

### 心跳

- Relay 每 25 秒在每条控制连接上发送 WebSocket ping，到下一次发送时仍没收到 pong 就强制断开（`terminate()`，不等关闭握手）并注销 ID。有语义的关闭（4401、4408、4409）先发 Close 帧再断开。
- 用 WebSocket ping，不用 HTTP/2 PING：它在 HTTP/2 之下，也能让电脑和 Relay 之间的 HTTP 代理看到流量，不因空闲而断开。
- 电脑端超过 60 秒没收到 ping 就认为连接已断并重连（电脑端 change）。

### 限速和额度

- 带宽上限按 ID、按方向，用令牌桶实现，速率为配置值，桶容量为 1 秒的量。令牌不足时暂停读取来源一侧（上行暂停手机 socket，下行暂停 stream），不丢数据。
- 每日额度按 ID 统计两个方向在手机一侧的字节数之和，含 TLS 开销，即运营方实际支付的流量。计数只在内存中，键是 ID，所以重连不清零，Relay 重启清零。
- 超额时只放行 ALPN 列表恰好为 `acme-tls/1` 的连接，每条限 64 KiB 和 10 秒，另外每个 ID 每小时这类连接合计不超过 1 MiB，超出即拒绝。它们仍计入并发上限和带宽上限。ALPN 是客户端自报的，Relay 无法确认对方是证书机构，只有按 ID 的合计上限才能防止反复建立小连接绕过额度。TLS-ALPN-01 只做握手、不传应用数据，Let's Encrypt 每次验证从约 5–7 个地点各连一次，1 MiB 远大于所需。被恶意耗尽时只影响该 ID 一小时内的续期。

### 配置和运行

- 命令行参数：`--domain`、`--control-host`（默认等于 `--domain`）、`--cert`、`--key`、`--port`（默认 443）、`--rate`（每方向字节/秒）、`--daily-quota`（字节）。后两项不传时不限制，自托管通常不需要。
- 收到 `SIGHUP` 时重新读取控制地址证书并替换 TLS 上下文，已有连接不受影响。部署者用 certbot 等工具续期后发送该信号。
- 日志以 JSON 行写到 stdout，只记录注册、注销、替换和超额事件，字段限于 ID、IP、时间、字节数和原因。

### 包和导出

- `packages/remote-relay` 只依赖 Node 内置模块和 `ws`，不依赖其他工作区包。
- 子路径导出 `@codexhost/remote-relay/protocol`：ID 派生、签名内容构造、路径、请求头名和关闭码。电脑端从这里导入，两侧不各写一份。
- 可执行入口只负责解析参数和启动，ClientHello 解析、注册、转发和限速分别放在独立模块，便于单测。

## Risks / Trade-offs

- [守着 443 的一方能用 TLS-ALPN-01 自行申请证书] → 证书透明日志可用于发现冒签，不能事先阻止，见[中转的信任边界](../../../../docs/product/web-remote-access.md#中转的信任边界)。
- [注册不需要邀请，任何人都能生成密钥并占用 Relay 内存] → 核心的身份验证不等于准入控制。
- [Relay 重启使当日额度清零] → 接受。额度用于控制成本，不是计费依据。
- [浏览器改走 HTTP/3 或加密 SNI 时无法路由] → Relay 只接受 TCP 上的明文 SNI；电脑端不得通过 Alt-Svc、HTTPS 记录或 ECH 配置宣告这些能力（电脑端 change）。

## Migration

新增包，没有既有数据。回滚即停止 Relay 部署，其他入口不受影响。
