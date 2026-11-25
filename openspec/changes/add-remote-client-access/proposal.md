# Proposal

## Why

外部客户端接入目前只在本机可用。实际的调用方很多不在这台机器上：其他开发机和手机通过 Tailscale 组网，常驻 bot（如 Grok Bot、dots）运行在厂商云端。托管 bot 的原生 MCP connector 只能访问公网 HTTPS，绕道 tailnet 就用不上原生能力。完成通知也需要主动推给 bot，才能唤醒它，而不是等它下一次轮询。

## What Changes

- 客户端增加**权限范围**：`read`（读取、列举、等待、事件）和 `dispatch`（另含委派、发送、取消、watch）。增加**网络范围**：`local`、`tailnet`、`public`，客户端只能从允许的网络访问。已有客户端迁移为 `dispatch` + `local`，行为不变。
- **tailnet 访问**：开启后，外部监听同时在本机的 Tailscale 地址上提供服务，默认关闭。
- **公网访问**：开启后，通过 Tailscale Funnel 以 HTTPS 暴露外部监听，供托管 bot 的 MCP connector 使用，默认关闭。公网入口支持 OAuth 授权：用户在本机生成一次性配对码，在授权页输入后，把访问权绑定到指定客户端。
- **webhook 推送**：可为客户端配置 webhook adapter 和目标地址。事件写入日志后由 adapter 主动推送，失败按退避重试；日志与 MCP 事件工具仍是兜底。首个 adapter 为 Grok Bot。
- 控制台显示各监听的状态、客户端的范围、最近一次访问和 webhook 投递状态。

## Decisions

- **默认全部关闭，逐个客户端放开。** 公网入口可以驱动本机 agent，打开它必须是用户对具体客户端做出的明确决定，而不是一个全局开关。
- **tailnet 上使用明文 HTTP + 令牌。** WireGuard 已经加密并鉴别设备，令牌负责区分客户端和吊销。不另做 TLS，避免证书管理。
- **公网使用 Tailscale Funnel，不自建中继。** 用户已有 tailnet，Funnel 提供 HTTPS 与公网可达性；codexhost 只管理自己的路径映射，不改动用户的其他 serve/funnel 配置。
- **webhook 格式差异收在厂商 adapter 里。** 与 Harness adapter 同一思路：Host 只产出统一事件，各 adapter 负责目标格式、签名和重试细节。换 bot 时新增 adapter，不改 Host。
- **先验证，后实现认证与 adapter。** Grok Bot 的 MCP connector 是否必须 OAuth、webhook 触发器要求什么 payload 与签名，都以真实环境验证为准（tasks 第 0 组）。结论可能删减 OAuth 部分，但不改变权限和网络范围的设计。
- 不在本提案内：按仓库或工作目录的白名单、能力细分（如禁止合并）。当前使用方式不需要，作为后续提案。

## Capabilities

### New Capabilities

- `remote-client-access`：tailnet 与公网监听、权限和网络范围、OAuth 配对授权、webhook adapter 推送。

### Modified Capabilities

- `external-client-access`：“外部客户端可以作为委派来源”加入权限范围约束。

## Impact

`packages/host-runtime`（监听、范围检查、OAuth 端点、webhook 投递）、新增 webhook adapter 包（首个 `grok-bot`）、`packages/console-server`（状态展示与开关）、`shared-contracts`（范围与 webhook 配置结构）。依赖本机已安装并登录 Tailscale；未安装时，tailnet 与公网选项显示不可用。依赖 `add-external-client-access`。
