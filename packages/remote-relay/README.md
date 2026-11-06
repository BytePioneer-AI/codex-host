# Remote Relay

独立的 SNI 字节转发服务，只依赖 Node.js 和 `ws`。手机 TLS 在电脑端终止，Relay 只持有控制地址的证书，不持有用户证书，不保存转发内容。电脑端接入与用户证书申请由后续 change 提供；本包不启动 Host 或 Web。

## 启动

在仓库根目录安装依赖并构建本包：

```sh
npm install
npx tsc -b packages/remote-relay/tsconfig.json
node packages/remote-relay/dist/cli.js \
  --domain relay.example \
  --control-host control.relay.example \
  --cert /etc/letsencrypt/live/control.relay.example/fullchain.pem \
  --key /etc/letsencrypt/live/control.relay.example/privkey.pem
```

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--domain` | 用户子域的基础域名 | 必填 |
| `--control-host` | 控制连接的主机名 | 与 `--domain` 相同 |
| `--cert` | 控制地址的 PEM 证书链路径 | 必填 |
| `--key` | 控制地址的 PEM 私钥路径 | 必填 |
| `--port` | TCP 监听端口 | `443` |
| `--rate` | 每地址名、每方向的字节/秒，正整数；令牌桶容量为一秒的量 | 不限制 |
| `--daily-quota` | 每地址名的 UTC 日双向总字节额度，正整数，含 TLS 开销 | 不限制 |
| `--max-connections` | 监听端口的 TCP 连接总数上限，正整数；包含电脑、手机和尚未完成 ClientHello 的连接 | 不限制 |

程序以前台单进程运行，监听全部网络接口。没有环境变量配置、后台守护、重试或自动端口回退。启动配置或证书读取失败由 Node 报错退出。

## 部署要求

- 公网 TCP 443 可达；TLS-ALPN-01 的真实 CA 验证要求 443。非特权端口只用于本地测试。
- `*.relay.example` 和控制地址解析到 Relay。若控制地址等于基础域名，还需该域名的解析记录。
- 控制地址有有效的证书链和私钥；进程具有读取权限及绑定 443 的权限。
- 用户连接不能经过会终止 TLS 的 HTTP 反向代理或 CDN。Relay 必须看到原始 ClientHello 和明文 SNI；不支持 QUIC/HTTP/3 或 ECH。
- 电脑仅主动连接 `wss://<控制地址>/v1/agent`，用户证书在电脑上申请、保存和使用。独立部署者仍有能力通过控制 443 为子域申请证书，不能将本方案描述为运营方绝对无法解密。

更新控制证书文件后向 **Relay 进程**发送 `SIGHUP`：

```sh
kill -HUP <relay-pid>
```

进程重新读取 `--cert`、`--key` 并替换 TLS 上下文；已有控制和手机连接不受影响。应先确保新文件完整且证书与私钥匹配；读取或解析错误会使进程退出，没有旧证书回退机制。

## 嵌入与注册检查

`@codexhost/remote-relay` 导出 `createRelay(options)`、`RelayOptions`、`RegistrationRequest` 和 `RegistrationResult`。`options` 的 `domain`、`controlHost`、`cert`、`key`、`rate`、`dailyQuota`、`maxConnections` 与启动参数同义，另有可选的 `heartbeatInterval`（毫秒，默认 25000）及两个回调：

```ts
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
  onUsage?: (name: string, bytes: number) => void;
}

type RegistrationResult =
  | { name: string; rate?: number; dailyQuota?: number; usedToday?: number }
  | { reject: "invite" | "name-taken" | "banned" | "full" };
```

`check` 仅在签名验证通过后调用，接收公钥派生的 ID、电脑 IP 和挑战响应中的可选名字、邀请码。允许时返回合法 DNS 标签（1–63 位字母、数字或中间的连字符）；核心把它转成小写，主机名为 `<name>.<domain>`。名字分配、身份与名字的唯一对应、邀请码和停用规则由部署者负责。不提供 `check` 时忽略提交的名字和邀请码，仍以公钥派生 ID 注册。

返回的 `rate`、`dailyQuota` 优先于启动选项，省略时沿用启动值，均以字节为单位。`usedToday` 默认 0，作为 UTC 当天的用量起点；内存中已有该名字当天用量时，以内存为准。重连更新限速和额度，不清零当天用量或 ACME 小时用量。`onUsage` 与额度使用同一次计数，包括两个方向、ClientHello、TLS 开销和超额后的 ACME 验证流量；初始 `usedToday`、控制流和额度通知不重复上报。

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

核心没有邀请码登记表、封禁规则、监控、磁盘计数或 Docker 发行。

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
node packages/remote-relay/dist/cli.js --domain relay.test \
  --cert packages/remote-relay/test/fixtures/cert.pem \
  --key packages/remote-relay/test/fixtures/key.pem --port 4488
```

在另一个终端运行测试客户端：

```sh
node --import tsx packages/remote-relay/test/smoke.ts
```

客户端用测试内的假电脑注册，手机侧真实 TLS 经 Relay 转发到假电脑，在进程内终止 TLS 并返回 HTTP 200；成功输出 `relay forwarding OK`。完成后在 Relay 终端按 Ctrl-C，仅停止本次启动的 Relay。
