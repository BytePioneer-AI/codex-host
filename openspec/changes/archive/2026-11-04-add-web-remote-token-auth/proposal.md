# Proposal

## Why

通过 Tailscale、中转或隧道远程访问 Web，需要可撤销、不暴露给代理日志的认证，并区分本机链接与其他设备使用的令牌。

## What Changes

- 新增一个供其他设备使用的访问 token：保存明文，可在本机页面查看、复制和重新生成。
- 重新生成时立即拒绝旧 token 的请求，断开它的长连接并删除其推送订阅；运行中的任务不停止。
- Web 设置增加“连接设备”页。所有访问方式都能看到菜单，只有本机访问能看到二维码和 token；其他设备可在这里退出登录。
- 新增本机 token：只在本机访问时有效，不展示、不可删除，用于启动输出的本机链接。
- 新增链接登录（URL fragment）和手动输入登录，登录失败限速。
- 只有显式配置可信代理时才信任 `x-forwarded-*`。
- 所有响应增加 `X-Content-Type-Options: nosniff`，用户文件不能以同源页面的方式执行。
- **BREAKING** 现有访问令牌变为本机 token，手机和其他设备要用连接设备页的 token 重新登录。
- **BREAKING** 启动输出的网络地址和二维码不再带 token，手机要用连接设备页的 token 登录。
- **BREAKING** 移除 `--rotate-token`；现有无归属的推送订阅被丢弃，已开启通知的浏览器下次打开页面时自动重新关联。

## Decisions

- **只有一个访问 token，不做多 token 和临时 token。** 个人用户通常两三台设备，丢失设备后重新生成再扫码的代价很小，而令牌本来只能在电脑上管理，单独撤销在外面也用不上。放弃临时 token：持有者可以通过终端读取保存在电脑上的永久 token，也无法撤回到期前的操作，限时只会带来错误的安全感。以后确有需要时，从一个扩展到多个比反过来容易。
- **只校验 token，不绑定设备或浏览器。** 放弃配对和设备绑定：流程重，对个人工具收益小。
- **不设远程功能白名单。** 持有 token 就能通过终端在电脑上执行命令，白名单不构成真正的边界。
- **token 只在本机访问时可见和可重新生成，不提供命令行。** 代价是人在外面时无法让 token 失效，回到电脑前才能重新生成。“本机访问”用于防止手机上误操作，不是严格的安全边界。
- **退出登录只影响这个浏览器。** 用于借用设备的场景；重新登录要回到电脑查看 token，所以确认时明确提示。
- **不提供免 token 的本机访问。** frp TCP、`ssh -R` 等转发到回环地址的请求无法与本机区分，同机其他用户也能访问回环地址。
- **`npm start web` 保持默认监听 `0.0.0.0`。** 所有入口都要 token，本机 token 在网络地址上无效，默认不再收窄监听地址；需要时用 `--host 127.0.0.1` 限定。
- **本 change 只输出本机登录链接。** 自动打开浏览器由 `add-web-background-service` 提供。

## Capabilities

### New Capabilities

- `web-access-tokens`: Web 的访问 token、登录、重新生成、退出登录、本机访问判断、可信代理及相关的基础访问保护。

### Modified Capabilities

无。

## Impact

- `packages/web-server`：认证、HTTP 和 WebSocket 入口、推送、启动输出。
- `packages/shared-contracts`：访问 token 的浏览器安全类型。
- `apps/web-ui`：连接设备页、退出登录、登录失效处理、通知重新关联。
- 数据目录：新增 token 存储文件，`auth.json` 改为保存本机 token 并限制文件权限。
- 文档：`docs/product/standalone-web.md`、发行 README。
