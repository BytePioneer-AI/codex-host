# Remote Relay

独立的 SNI 字节转发服务，只依赖 Node.js、`ws` 和 `acme-client`。手机 TLS 在电脑端终止，Relay 只持有控制地址的证书，不持有用户证书，不保存转发内容。电脑端接入和用户证书申请由 Web 提供；本包不启动 Host 或 Web。

## 启动

Docker 源码构建、Compose 和自动证书说明见[自建中转](../../docs/product/self-hosted-relay.md)。镜像入口为 `codexhost-relay`，后续参数原样传入下表中的 CLI；镜像由用户从源码构建，暂不发布到镜像仓库。

直接从源码运行时，在仓库根目录安装依赖并构建本包：

```sh
npm install
npx tsc -b packages/remote-relay/tsconfig.json
node packages/remote-relay/dist/cli.js --domain example.com
```

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--domain` | 用户子域的基础域名 | 必填 |
| `--control-host` | 控制连接的主机名 | `relay.<domain>` |
| `--cert` | 已有控制地址 PEM 证书链路径，与 `--key` 成对提供 | 不提供时自动申请 |
| `--key` | 已有控制地址 PEM 私钥路径，与 `--cert` 成对提供 | 不提供时自动申请 |
| `--data-dir` | 自动证书与账户密钥的数据目录 | `./data`，容器 `/data` |
| `--port` | TCP 监听端口 | `443` |
| `--rate` | 每地址名、每方向的字节/秒，正整数；令牌桶容量为一秒的量 | 不限制 |
| `--daily-quota` | 每地址名的 UTC 日双向总字节额度，正整数，含 TLS 开销 | 不限制 |
| `--max-connections` | 监听端口的 TCP 连接总数上限，正整数；包含电脑、手机和尚未完成 ClientHello 的连接 | 不限制 |

CLI 支持电脑注册自选地址名，名称留空时使用公钥派生 ID。`names.json` 在数据目录中持久保存地址名与签名身份的绑定；同一身份可重用名称，其他身份不能抢占，控制地址与其他身份的派生 ID 也不可占用。程序以前台单进程运行，监听全部网络接口，无后台守护或端口回退。`CODEXHOST_RELAY_DATA_DIR` 可设置数据目录默认值，CLI 优先；`CODEXHOST_RELAY_ACME_DIRECTORY` 可指定测试 CA，默认 Let's Encrypt 生产目录。启动配置或手动证书读取失败由 Node 报错退出。

## 部署要求

- 公网 TCP 443 可达；TLS-ALPN-01 的真实 CA 验证要求 443。容器内部可监听非特权端口并映射到公网 443；直接使用其他端口只用于本地测试。
- 示例只需一条通配 DNS 记录 `*.example.com` 指向 Relay，同时覆盖控制地址 `relay.example.com` 和电脑地址 `<id>.example.com`。域名下已有的记录（如 `www`、根域）不受影响、照常使用，通配只覆盖没有单独记录的子域。默认电脑地址使用 26 位公钥派生 ID；自选名称时须避开 `www` 等已有独立记录的子域。Cloudflare 必须选“仅 DNS”；只在 IPv6 同样可达时添加 AAAA 记录。若控制地址等于基础域名或不在通配范围内，则仍需单独的解析记录。
- 中转自动为控制地址 `relay.example.com` 申请并续期 Let's Encrypt 证书，无需额外证书工具、80 端口或通配符证书；每台电脑自行申请自己的证书。直接监听 443 时需绑定特权端口的权限，Compose 已配置非 root 监听。
- 用户连接不能经过会终止 TLS 的 HTTP 反向代理或 CDN。Relay 必须看到原始 ClientHello 和明文 SNI；不支持 QUIC/HTTP/3 或 ECH。
- 电脑仅主动连接 `wss://<控制地址>/v1/agent`，用户证书在电脑上申请、保存和使用。独立部署者仍有能力通过控制 443 为子域申请证书，不能将本方案描述为运营方绝对无法解密。

自动证书模式下，数据目录保存 `acme-account.pem`、`certificate-key.pem` 和 `certificate.pem`，文件权限 0600。Compose 持久化 `/data`，重启复用密钥与有效证书；每 15 分钟检查，在实际有效期的 2/3 处续期并原子替换，无需重启。失败后约 15 分钟自动重试，重启容器会立即重试；旧证书有效时继续使用，到期后拒绝新的普通控制连接。首次签发前只应答控制地址证书验证。Let's Encrypt 有频率限制，不要反复删除数据卷或更换域名。

已有证书时可成对提供 `--cert/--key`，不自动申请。更新这些文件后向 **Relay 进程**发送 `SIGHUP`：

```sh
kill -HUP <relay-pid>
```

进程重新读取 `--cert`、`--key` 并替换 TLS 上下文；已有控制和手机连接不受影响。应先确保新文件完整且证书与私钥匹配；读取或解析错误会使进程退出，没有旧证书回退机制。

## 嵌入与注册检查

`@codexhost/remote-relay` 导出 `createRelay(options)`、`RelayOptions`、`RegistrationRequest` 和 `RegistrationResult`。`options` 的 `domain`、`controlHost`、`cert`、`key`、`dataDir`、`rate`、`dailyQuota`、`maxConnections` 与启动参数同义，另有可选的 `heartbeatInterval`（毫秒，默认 25000）及以下可选回调：

```ts
import type { IncomingMessage, ServerResponse } from "node:http";

interface RegistrationRequest {
  id: string;
  ip: string | undefined;
  name?: string;
  invite?: string;
}

interface RelayOptions {
  // 其他选项略。
  check?: (request: RegistrationRequest) => RegistrationResult | Promise<RegistrationResult>;
  // 每次转发的增量字节数，不是累计值；应同步接收，持久化可自行批量执行。
  onUsage?: (name: string, bytes: number, details: UsageDetails) => void;
  onConnection?: (event: ConnectionEvent) => void;
  onRequest?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

type RegistrationResult =
  | { name: string; rate?: number; dailyQuota?: number; usedToday?: number }
  | { reject: "invite" | "name-taken" | "banned" | "full" };
```

`check` 仅在签名验证通过后调用，接收公钥派生的 ID、电脑 IP 和挑战响应中的可选名字、邀请码。允许时返回合法 DNS 标签（1–63 位字母、数字或中间的连字符）；核心把它转成小写，主机名为 `<name>.<domain>`。名字分配、身份与名字的唯一对应、邀请码和停用规则由部署者负责。不提供 `check` 时忽略提交的名字和邀请码，仍以公钥派生 ID 注册。

返回的 `rate`、`dailyQuota` 优先于启动选项，省略时沿用启动值，均以字节为单位。`usedToday` 默认 0，作为 UTC 当天的用量起点；内存中已有该名字当天用量时，以内存为准。重连更新限速和额度，不清零当天用量或 ACME 小时用量。`onUsage` 与额度使用同一次计数，包括两个方向、ClientHello、TLS 开销和超额后的 ACME 验证流量；初始 `usedToday`、控制流和额度通知不重复上报。

`UsageDetails` 和 `ConnectionEvent` 也由包入口导出。`onUsage` 的第三参数为 `{ direction: "upload" | "download", acme: boolean, quotaExceeded: boolean }`，upload 指手机到电脑，download 指电脑到手机；`quotaExceeded` 仅本次增量首次触达当天额度时为 true。现有双参数回调不需要修改。

`onConnection` 同步接收以下事件，所有时间为 Unix 毫秒；回调应仅更新内存，持久化自行批量执行，不应抛错：

- `{ type: "computer", state: "online", name, ip, time }`：成功注册并进入在线表后触发，即使未提供 `check` 也会触发。
- `{ type: "computer", state: "offline", name, ip, time, reason }`：注销时仅触发一次；reason 为 `replace`（被替换）、`timeout`（心跳超时）或 `unregister`（断开、主动注销、关闭服务等）。注册失败不会产生上下线事件。
- `{ type: "phone", state: "open", id, name, ip, startedAt, acme }`：连接获准转发；容量或额度拒绝的连接不报告。
- `{ type: "phone", state: "authenticated", id, name, ip, startedAt, acme: false, time }`：电脑端确认访问令牌或登录 Cookie 校验通过；按同一连接、UTC 日去重。它不同于原始 `open`：普通连接、扫描、认证失败及证书验证不产生该事件。IP 和身份来自对应的中转连接，不接受浏览器填报；旧电脑不报告，不能把其历史连接推算为已认证访问。
- `{ type: "phone", state: "close", id, name, ip, startedAt, acme, endedAt, upload, download }`：同一连接关闭，含两个方向的累计转发字节，与增量计数一致。`id` 在该连接生命周期内不变。

ALPN 恰好为 `acme-tls/1` 时，连接与用量始终标记 `acme: true`（不只超额后）；部署者可排除证书验证的手机使用次数和时长，但它的流量仍计入额度。不提供回调不改变注册或转发行为。

认证报告只通过已签名注册的电脑控制会话传输：`POST /v1/tcp` 带中转生成的 `relay-connection-id`；电脑校验访问凭据后，使用该 HTTP/2 会话的 server push 发送 `GET /v1/authenticated`，带相同 ID，响应 204 且正文为空。核心只接受该电脑仍存活的非 ACME 连接 ID，忽略未知、其他电脑或已关闭连接的 ID，并按 UTC 日去重。不增加公网认证报告路由，也不传输令牌、Cookie、请求路径或转发内容。旧 Relay 不提供连接 ID，电脑不报告；统计失败不影响登录。此事件是电脑端的认证观测，不代表人数、登录操作次数或应用请求成功。

`onRequest` 接收控制地址上未升级为 WebSocket 的 HTTP 请求，可用于提供部署者自定路径的页面，由处理函数完成响应；未提供时返回 404。同步抛错或返回的 Promise 被拒绝时，尚未发送响应头则返回 500，否则关闭该响应，不影响 Relay 进程。WebSocket 升级路径和按地址名的 SNI 转发不经过该回调。

返回值包含 `server`、`close()` 和 `disconnect(name)`。调用者自行 `server.listen(port)`；`disconnect` 立即注销地址并关闭其控制和手机连接，未知名字无操作。再次连接须重新经过 `check`，可借此使新额度或停用规则生效。

`check` 抛错或返回非法 DNS 标签时，注册失败，以普通关闭码 `1000` 关闭，不返回注册正文；检查也受从连接建立起的 10 秒注册时限约束，超时为 `4408`，迟到的检查结果不生效。

## 协议与限制

协议导出为 `@codexhost/remote-relay/protocol`，完整契约见 [design.md](../../openspec/changes/archive/2026-11-06-add-remote-relay-server/design.md)。

- Ed25519 公钥的 SHA-256 前 16 字节编码为 26 位小写 base32 ID。
- 每个控制连接一次 32 字节挑战，签名绑定小写、无端口、无末尾点的控制主机名。电脑在回复挑战的同一个响应中，除 `relay-public-key`、`relay-signature` 外，可带 `relay-name`、`relay-invite`。注册通过仍返回 `{ hostname }`；注册前不转发手机。
- 注册拒绝直接关闭控制连接，不发送注册正文。关闭码：`4401` 无效签名，`4408` 10 秒注册超时，`4409` 同地址名的新连接替换，`4410` 邀请码无效（`invite`），`4411` 名字已被占用（`name-taken`），`4412` 已被停用（`banned`），`4413` 容量已满（`full`）。
- WSS 只协商 `http/1.1`，不压缩，单消息上限 1 MiB；其上 Relay 是 HTTP/2 客户端，电脑是服务端。
- 每条手机连接对应 `POST /v1/tcp`，传递来源 IP/端口；FIN 独立传递，异常中断两端。
- 每地址名最多 32 条手机连接；每流接收窗口 2 MiB、连接窗口 8 MiB。Node 自动补充连接窗口，因此总缓存并非 8 MiB：每地址名每方向约最多 64 MiB，另加 WebSocket 消息及传输缓冲。
- ClientHello 最多 16 KiB、10 秒，支持跨 TCP 分段和 TLS 记录。SNI 子域接受合法 DNS 标签，不限于 26 位 ID；缺 SNI、非法域名和离线地址名直接断开。
- 每 25 秒发送 WebSocket ping；下一周期仍无 pong 时 `terminate()` 并注销。
- 达到总 TCP 上限时直接关闭新连接，已有连接不受影响；连接关闭后释放名额。被拒绝的电脑沿用随机退避重连。
- 日额度达到后关闭该地址名现有手机连接。仅 ALPN 列表恰为 `acme-tls/1` 的新连接可例外转发：每条双向合计 64 KiB、10 秒，每地址名每 UTC 整点小时合计 1 MiB；仍受 32 条并发与带宽限制。
- 首次达到当天额度时，通过控制连接发送 `POST /v1/notice`，正文为 `{"quota":"exhausted","until":"<下一个 UTC 日的 ISO 时间>"}`，例如 `{"quota":"exhausted","until":"2026-11-07T00:00:00.000Z"}`。注册时已超额也会发送通知。控制连接保持，次日恢复访问；旧电脑拒绝通知流不影响控制连接。
- 字节计数为手机侧转发的加密字节，两个方向相加。日额度和验证小时额度按地址名留在内存，重连不清零；重启后可通过 `usedToday` 恢复当天用量，否则从零起算。UTC 日期/小时变化时按需清零。
- 每小时清理早于 UTC 当天、且对应电脑当前未注册的用量记录；当天的离线记录保留，断开后重连不能清零当天额度。当前已注册电脑的记录也保留。
- 不提供 `check` 时，任何持有有效签名的电脑都能注册，依次更换身份可获得新 ID 的每日额度。准入、注册数量限制和封禁规则不在核心中。

## 日志

stdout 仅输出 JSON 行，不输出启动信息、逐连接统计或转发内容。字段：

| 字段 | 内容 |
| --- | --- |
| `reason` | `register` 注册、`unregister` 注销、`replace` 替换、`quota` 首次达到当日额度 |
| `id` | 注册使用的地址名；未提供检查时为公钥派生的 ID |
| `ip` | 注册/注销/替换时为电脑 IP；超额时为触发该事件的手机 IP |
| `time` | UTC ISO 8601 时间 |
| `bytes` | 仅超额事件携带该地址名的当日累计字节数 |

核心没有邀请码登记表、封禁规则、监控或磁盘计数。自建部署不提供准入功能；Docker 和 Compose 示例见[自建中转](../../docs/product/self-hosted-relay.md)。

## 本机验证

以下固定测试凭据是公开的自签证书和私钥，**不可用于部署**。现有测试使用 4480–4482，连接上限测试使用系统分配的端口；手动验证使用 4488。

```sh
npx vitest run --config tests/vitest.config.js packages/remote-relay
npx tsc -b packages/remote-relay/tsconfig.json
npx eslint packages/remote-relay
npx prettier --check packages/remote-relay
```

在一个终端启动 Relay：

```sh
node packages/remote-relay/dist/cli.js --domain relay.test --control-host relay.test \
  --cert packages/remote-relay/test/fixtures/cert.pem \
  --key packages/remote-relay/test/fixtures/key.pem --port 4488
```

在另一个终端运行测试客户端：

```sh
node --import tsx packages/remote-relay/test/smoke.ts
```

客户端用测试内的假电脑注册，手机侧真实 TLS 经 Relay 转发到假电脑，在进程内终止 TLS 并返回 HTTP 200；成功输出 `relay forwarding OK`。完成后在 Relay 终端按 Ctrl-C，仅停止本次启动的 Relay。
