# Proposal

## Why

普通用户应能在连接设备页完成中转配置，不需要先运行命令行。未配置时隐藏入口以及自建中转被称为官方中转，都会误导用户。

## What Changes

- 本机连接设备页始终提供中转方式，默认控制地址为 `relay.chost.dev`，默认不开启。
- 增加与官方、Tailscale、局域网平级的“自建中转”卡片，包含主机名输入并一步启用、启停状态、扫码和简短双语部署教程；配置后教程折叠，访问地址紧跟开关。
- 官方中转保留地址名与邀请码；自建中转开启后只读显示控制地址，不显示或提交这两项。两种方式均以数据目录相对路径简述身份密钥。
- 更换控制地址不沿用旧分配地址与证书，保留电脑身份；中英文说明采用“正常转发时不解密内容”的信任边界。
- 更新远程访问、独立 Web、自建中转文档，以页面配置为主。

## Decisions

- 同一时间只能开启一个中转，必须先关闭才能切换方式或更换控制地址，避免隐式断开与重新注册。
- 官方卡片固定 `relay.chost.dev`。保留 `--relay` 仅预填或覆盖自建地址，兼容开发使用的 `localhost:端口`；空值清除自建地址，不改变官方卡片。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `web-relay-access`：页面配置、官方默认、自建展示及切换隔离。

## Impact

影响 `packages/web-server`、`packages/shared-contracts`、`apps/web-ui/packages/client/ui-codexhost`，扩展现有 `codexhost/relaySet` 和访问状态契约；不新增依赖，不修改 Relay 协议、Host 生命周期或会话历史。
