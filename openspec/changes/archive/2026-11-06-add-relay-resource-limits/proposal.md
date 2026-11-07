# Proposal

## Why

Relay 当前只限制单 ID 的连接和流量，部署者无法限制服务器上的 TCP 连接总数，离线身份的历史用量记录也会一直保留。这两项属于保护服务器本身，自建和官方中转都需要。

## What Changes

- 增加可选的 `--max-connections`，限制监听端口的 TCP 连接总数，不配置时不限制。
- 清理已过 UTC 当天且对应电脑未注册的用量记录；当天断线重连仍保留额度。

## Decisions

- 连接总数上限用于保护服务器本身，不代替准入控制。注册检查可通过核心的可选扩展接口提供。
- 连接总数直接用 Node `net.Server.maxConnections`。

## Capabilities

### Modified Capabilities

- `remote-relay`：可选的 TCP 连接总数上限、历史用量清理。

## Impact

影响 `packages/remote-relay` 的启动参数和用量生命周期，以及 `packages/web-server` 的重连回归测试；更新 Relay README。无新依赖。
