# Proposal

## Why

手机不装软件、通过子域名访问电脑，需要一台公网 Relay。阶段 3 已验证 SNI 转发、反向 HTTP/2 和 TLS-ALPN-01 可行。这是[实施计划](../../../docs/proposals/web-remote-implementation-plan.md)阶段 5 的第一个 change，先做 Relay 服务端；电脑端和证书在后两个 change。

## What Changes

- 新增 `packages/remote-relay`：独立部署的 Relay，官方和自托管使用同一份程序，区别只在配置。
- 电脑通过 WSS 连接 Relay 的控制地址，用身份私钥签名注册。子域 ID 由公钥派生，Relay 自己计算 ID，不接受电脑声明的名字。
- Relay 在 443 读取手机 TLS ClientHello 中的 SNI，把整条加密连接交给对应电脑，不解开 TLS，不持有用户证书，不写盘。
- 每条手机连接对应控制连接上的一个反向 HTTP/2 stream，把客户端 IP 告诉电脑。
- 按子域限制带宽和每日流量。超额后仍放行证书验证连接，但单条验证连接的字节数和时长有上限。
- 同一身份重复注册时新连接替换旧连接；Relay 定时心跳，检测已断开但没有正常关闭的控制连接。
- 导出协议常量和 ID 派生，供后续电脑端 change 使用。

## Decisions

- **只做 WSS 控制连接，不做原始 TLS。** 阶段 3 实测两者吞吐和时延无差别，WSS 能经过 HTTP 代理和只放行 HTTPS 的网络。
- **反向 HTTP/2 承载多路复用，不自定义帧格式。** 流控、背压和半关闭由 HTTP/2 提供。不使用每条手机连接单独回拨一条 TCP 的做法（rathole、bore），它多一次握手，也更容易碰到 NAT 和代理限制。
- **子域由公钥派生，不做账户。** 没有私钥就无法注册该子域，Relay 不需要维护名字归属。代价是私钥丢失后只能换新地址，这由电脑端负责提示备份。
- **Relay 不申请任何用户证书，也不碰 DNS。** 证书由电脑通过 TLS-ALPN-01 自行申请（第三个 change）。这样 Relay 正常运行时无法解密，但守着 443 的一方仍能自己完成验证，威胁模型见[总体设计](../../../docs/proposals/web-remote-relay-architecture.md#7-信任边界)。
- **不复用开源实现。** SniTun 是 GPL-3.0、Python，协议自带加密层；其余项目要么在服务端解开 TLS，要么不提供按子域 SNI 路由。
- **流量计数只保存在内存。** 重连不清零，Relay 重启清零。Relay 重启很少，换来不写盘。

## Capabilities

### New Capabilities

- `remote-relay`：Relay 的电脑注册、SNI 路由、多路复用、限速与额度、心跳和替换，以及它与电脑之间的协议。

### Modified Capabilities

无。

## Impact

- 新增 `packages/remote-relay`，只依赖 Node 内置模块和 `ws`；纳入 `tsconfig.json` 引用和 `tools/check-boundaries.mjs`，不得依赖 `host-runtime`、Adapter 或 Web Server。
- 后续 `packages/web-server` 通过 `@codexhost/remote-relay` 的协议导出使用 ID 派生和注册格式。
- 部署要求：一台监听 443 的公网服务器、控制地址的证书，以及泛域名解析。
- 更新总体设计第 12 节中已在本 change 确定的问题（控制协议、流控参数、是否传客户端 IP）。
