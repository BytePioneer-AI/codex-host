# Proposal

## Why

中转访问的连接握手成本较高。短暂空闲后重新建连和 HTTP/1.1 并发连接限制会增加手机操作等待。

## What Changes

- Web 的 HTTP/1.1 空闲保持时间统一为 120 秒。
- 中转 TLS 优先协商 HTTP/2，保留 HTTP/1.1 和 WebSocket；其他入口协议不变。
- 保持认证、请求归属、同源检查、压缩与流式传输语义。

## Decisions

120 秒面向浏览器分钟级空闲复用，同时限制连接占用；浏览器仍可提前回收。HTTP/2 不启用扩展 CONNECT，WebSocket 使用独立 HTTP/1.1 连接。不改 Relay 的转发协议或证书逻辑。

## Capabilities

### Modified Capabilities

- `web-relay-access`：中转支持 HTTP/2 多路复用及 HTTP/1.1 回退。
- `web-remote-access`：HTTP/1.1 空闲连接保持 120 秒。

## Impact

仅 `packages/web-server`、其测试和远程访问文档；无新增依赖、配置或监听端口。
