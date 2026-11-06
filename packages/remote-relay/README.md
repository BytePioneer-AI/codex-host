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
| `--rate` | 每 ID、每方向的字节/秒，正整数；令牌桶容量为一秒的量 | 不限制 |
| `--daily-quota` | 每 ID 的 UTC 日双向总字节额度，正整数，含 TLS 开销 | 不限制 |

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

## 协议与限制

协议导出为 `@codexhost/remote-relay/protocol`，完整契约见 [design.md](../../openspec/changes/add-remote-relay-server/design.md)。

- Ed25519 公钥的 SHA-256 前 16 字节编码为 26 位小写 base32 ID。
- 每个控制连接一次 32 字节挑战，签名绑定小写、无端口、无末尾点的控制主机名。注册前不转发手机；无效签名、10 秒注册超时、同 ID 替换分别发送关闭码 `4401`、`4408`、`4409`。
- WSS 只协商 `http/1.1`，不压缩，单消息上限 1 MiB；其上 Relay 是 HTTP/2 客户端，电脑是服务端。
- 每条手机连接对应 `POST /v1/tcp`，传递来源 IP/端口；FIN 独立传递，异常中断两端。
- 每 ID 最多 32 条手机连接；每流接收窗口 2 MiB、连接窗口 8 MiB。Node 自动补充连接窗口，因此总缓存并非 8 MiB：每 ID 每方向约最多 64 MiB，另加 WebSocket 消息及传输缓冲。
- ClientHello 最多 16 KiB、10 秒，支持跨 TCP 分段和 TLS 记录。缺 SNI、非法域名和离线 ID 直接断开。
- 每 25 秒发送 WebSocket ping；下一周期仍无 pong 时 `terminate()` 并注销。
- 日额度达到后关闭该 ID 现有手机连接。仅 ALPN 列表恰为 `acme-tls/1` 的新连接可例外转发：每条双向合计 64 KiB、10 秒，每 ID 每 UTC 整点小时合计 1 MiB；仍受 32 条并发与带宽限制。
- 字节计数为手机侧转发的加密字节，两个方向相加。日额度和验证小时额度按 ID 留在内存，重连不清零，Relay 重启清零；UTC 日期/小时变化时按需清零。

## 日志

stdout 仅输出 JSON 行，不输出启动信息、逐连接统计或转发内容。字段：

| 字段 | 内容 |
| --- | --- |
| `reason` | `register` 注册、`unregister` 注销、`replace` 替换、`quota` 首次达到当日额度 |
| `id` | 公钥派生的 ID |
| `ip` | 注册/注销/替换时为电脑 IP；超额时为触发该事件的手机 IP |
| `time` | UTC ISO 8601 时间 |
| `bytes` | 仅超额事件携带该 ID 的当日累计字节数 |

没有邀请码、封禁、监控、磁盘计数或 Docker 发行。

## 本机验证

以下固定测试凭据是公开的自签证书和私钥，**不可用于部署**。测试仅使用 4480–4482；手动验证使用 4488。

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
