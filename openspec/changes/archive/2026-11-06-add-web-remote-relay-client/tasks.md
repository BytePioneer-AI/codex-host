# Tasks

## 1. 电脑端连接

- [x] 1.1 身份密钥和设置：`remote-relay/identity.pem` 的生成与读取（0600），`--relay` 保存为 `relayHost`，`relayEnabled` 与 RPC `codexhost/relaySet`（要求本机访问，不重启；`--no-auth` 时拒绝）。验证：`packages/web-server` 单测覆盖首次生成、重启后沿用、删除后得到新 ID、文件权限；HTTP 测试覆盖非本机修改被拒、`--no-auth` 时启动不连接且开关返回错误、清除 `--relay` 后不显示开关。
- [x] 1.2 控制连接和注册：WSS（含 `HTTPS_PROXY` 的 CONNECT）、HTTP/2 服务端、注册应答、流窗口 2 MiB 和连接窗口 8 MiB、WebSocket 消息上限 1 MiB、单次连接尝试 30 秒期限、60 秒无心跳强制断开并重连、退避与抖动、4409/4401/404 后停止。验证：集成测试使用 `@codexhost/remote-relay` 在进程内启动的真实 Relay（缩短心跳间隔）和测试 CA，覆盖注册成功、连接卡在代理或升级阶段时 30 秒后重试、Relay 重启后重新注册、被替换后停止、版本不支持后停止、停止心跳后重连、经本机测试 HTTP 代理连接。
- [x] 1.3 进程内 TLS 和请求归属：不监听的 `tls.Server`（只有 `http/1.1`，握手 10 秒期限）把手机 stream 交给现有 HTTP 服务；缺少证书时重置；`RequestTrust` 识别中转 socket 并按完整 Origin 校验；中转响应带 HSTS；所有入口的 HTML 带 `frame-ancestors 'self'`；HTTPS 下 Cookie 使用 `__Host-` 前缀。验证：端到端测试中手机侧是真实 TLS 客户端，经 Relay 完成登录、RPC 和 `/api/remote.mux` WebSocket；覆盖缺少证书、握手停滞 10 秒后关闭、伪造 `x-forwarded-for` 被忽略、`http://` 或兄弟子域的 Origin 被拒、HSTS 和 frame-ancestors 响应头、按 Relay 告知的 IP 限速、两台手机互不影响、Cookie 名和属性、响应中没有 Alt-Svc、大下载期间另一条连接的请求及时得到响应。

## 2. 界面和文档

- [x] 2.1 连接设备页：配置了 `--relay` 时显示中转开关、状态和地址、身份密钥说明；已连接的中转地址按 spec 的顺序参与默认地址选择。验证：Playwright 覆盖开关切换后状态刷新、各状态文案、手机访问时不显示开关、手机宽度布局、地址选择顺序。
- [x] 2.2 文档：更新 `docs/product/web-remote-access.md`（中转入口、身份密钥、代理）、`docs/product/standalone-web.md` 中的 `--relay` 选项。验证：文档中的选项和状态与实现一致。
