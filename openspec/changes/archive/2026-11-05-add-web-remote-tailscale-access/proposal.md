# Proposal

## Why

Tailscale Serve 入口需要正确处理 HTTPS Cookie、客户端地址和登录限速，自备隧道需要公开地址配置，手机端需要区分网络问题和电脑离线。

## What Changes

- 连接设备页只读显示 Tailscale 状态：未安装、未运行、未登录、未开启 HTTPS、未转发、已转发到别处、已转发到当前 Web，并给出下一步提示。未转发时显示可复制的开启命令。
- 检测到 Serve 正转发到当前 Web 时，自动信任回环地址上的转发头；Serve 撤销后恢复不信任。
- 启动输出增加 Serve 地址；经 Funnel 公开到互联网的地址单独标明。
- 新增 `--public-url` 和 `CODEXHOST_WEB_PUBLIC_URL`，配置的地址排在最前，用于链接和二维码。
- 手机端增加“电脑离线”状态，与“网络断开”“正在重连”“Host 不可用”分开。
- 新增远程访问文档，覆盖 Serve、Funnel、frp、Cloudflare Tunnel 和 nginx。

## Decisions

- **本 change 只读检测 Tailscale 配置。** 开关能力由 `add-web-background-service` 提供。
- **可信代理从 Serve 状态推导，不保存设置。** 保存开关会在用户执行 `tailscale serve reset` 后过期，也覆盖不了手动开启的 Serve。放弃默认信任回环地址：frp TCP、`ssh -R` 等转发也来自回环地址，不应未经用户配置就被信任。
- **诊断只报告电脑能确定的状态，不做连通性自测。** 电脑访问自己的 Serve 地址成功，不能说明手机能连上。
- **公开地址只接受站点根地址，不自动信任隧道。** 代理的来源地址只有用户知道，所以可信代理继续手动配置。
- **连接状态复用现有提示。** 无网络、连接中、恢复中、Host 不可用和 token 失效已有界面，只补“电脑离线”。已连接时不显示常驻提示。

## Capabilities

### New Capabilities

- `web-remote-access`: 通过 Tailscale Serve 和自备隧道远程访问 Web，包括状态检测、公开地址及手机端连接状态。

### Modified Capabilities

- `web-access-tokens`: 可信代理增加由 Serve 转发推导的来源；连接设备页增加公开地址和 Funnel 地址的选择规则。

## Impact

- `packages/web-server`：Tailscale 状态读取、可信代理、新启动参数、启动输出、发行 README。
- `packages/shared-contracts`：连接设备接口的结果类型，新增地址种类和 Tailscale 状态。
- `apps/web-ui`：连接设备页、连接状态提示。
- 外部依赖：只读调用用户已安装的 `tailscale` 命令，不新增依赖。
- 文档：新增 `docs/product/web-remote-access.md`，更新 `docs/index.md`、`docs/product/standalone-web.md`。
