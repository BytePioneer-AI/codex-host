# Proposal

## Why

返回最近看过的 Web 会话会重发完整历史窗口，即使内容没有变化。按已确认的日志位置续传，减少本地与远程传输，同时保持缓存即时展示和运行回合恢复正确。

## What Changes

- 页面内最近会话缓存携带日志代次和已确认游标；返回时请求续传。
- 连续日志只返回新增持久事件及最新恢复基线；无法证明连续时返回现有窗口快照。
- 保留同步提示、阅读位置恢复、同步前操作限制和 8 个会话的内存缓存边界。
- 补充历史重写、进程重启、流式恢复和传输字节回归测试，更新现行功能文档。

## Decisions

- 统一以日志代次相同且游标处于连续保留范围判断续传，不按失效原因增设协议分支。
- 持久事件游标不代表流式状态；续传确认必须包含最新投影和 Assistant 基线。
- 只优化 Web 到浏览器，不改变 Host 指纹复用、压缩和原生 Harness 协议。

## Capabilities

### New Capabilities

- `web-session-history-sync`: 页面内缓存会话的游标续传、权威恢复与快照回退。

### Modified Capabilities

无。

## Impact

涉及 `packages/session-runtime`、`packages/web-server`、`apps/web-ui/packages/api/session-controller`，以及确有需要的 Gateway 日志流公开契约。扩展浏览器 follow 协议，不引入持久缓存或新依赖；维护 `docs/product/standalone-web.md`。
