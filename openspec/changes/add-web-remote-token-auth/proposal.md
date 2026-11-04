# Proposal

## Why

Web 现在只有一个访问令牌，所有设备共用，无法单独撤销，而且令牌只在建立长连接时校验。这是手机远程访问的第一步：无论后续通过 Tailscale、中转还是隧道访问，都依赖可单独管理和撤销的认证。对应[实施计划](../../../docs/proposals/web-remote-implementation-plan.md)的阶段 1。

## What Changes

- 新增多个命名 token：保存明文和哈希，可在本机管理页随时查看、复制和删除。
- 删除 token 时立即拒绝其请求，断开它的长连接并删除其推送订阅；运行中的任务不停止。
- Web 设置增加 token 管理页。所有访问方式都能看到菜单，只有本机访问能操作。
- 新增本机 token：只在本机访问时有效，不展示、不可删除，用于启动输出的本机链接。
- 新增链接登录（URL fragment）和手动输入登录，登录失败限速。
- 只有显式配置可信代理时才信任 `x-forwarded-*`。
- 所有响应增加 `X-Content-Type-Options: nosniff`，用户文件不能以同源页面的方式执行。
- **BREAKING** 现有访问令牌变为本机 token，手机和其他设备要用管理页创建的 token 重新登录。
- **BREAKING** 启动输出的网络地址和二维码不再带 token，手机要用管理页创建的 token 登录。
- **BREAKING** 移除 `--rotate-token`；现有无归属的推送订阅被丢弃，已开启通知的浏览器下次打开页面时自动重新关联。

## Decisions

- **只校验 token，不绑定设备或浏览器。** 同一 token 可在多台设备使用。放弃配对和设备绑定：流程重，对个人工具收益小。
- **所有 token 权限相同，不设远程功能白名单。** 持有 token 就能通过终端在电脑上执行命令，白名单不构成真正的边界。
- **管理只在本机访问时可用，不提供命令行。** 代价是人在外面时无法新增或删除 token，界面提示提前创建备用 token。“本机访问”用于防止手机上误操作，不是严格的安全边界。
- **不提供免 token 的本机访问。** frp TCP、`ssh -R` 等转发到回环地址的请求无法与本机区分，同机其他用户也能访问回环地址。
- **`npm start web` 保持默认监听 `0.0.0.0`。** 所有入口都要 token，本机 token 在网络地址上无效，默认不再收窄监听地址；需要时用 `--host 127.0.0.1` 限定。
- **自动打开浏览器不在本阶段。** 本阶段只输出带本机 token 的本机链接，打开浏览器由阶段 4 的统一启动命令负责。

## Capabilities

### New Capabilities

- `web-access-tokens`: Web 的命名 token、登录、撤销、本机访问判断、可信代理及相关的基础访问保护。

### Modified Capabilities

无。

## Impact

- `packages/web-server`：认证、HTTP 和 WebSocket 入口、推送、启动输出。
- `packages/shared-contracts`：token 管理的浏览器安全类型。
- `apps/web-ui`：token 管理页、登录失效处理、通知重新关联。
- 数据目录：新增 token 存储文件，`auth.json` 改为保存本机 token 并限制文件权限。
- 文档：`docs/product/standalone-web.md`、发行 README、实施计划状态。
