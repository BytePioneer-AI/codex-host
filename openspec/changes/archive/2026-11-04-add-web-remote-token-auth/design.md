# Design

## Context

Web 服务只有一个明文保存在 `auth.json` 的 token。`main.ts` 对所有 HTTP 请求校验它，`/api/remote.mux` 和侧栏浏览器 WebSocket 只在 upgrade 时校验。长连接还包括 `/api/ch/v1/events` 和开发用的热更新事件流。同一数据目录可能有多个 Web 进程（不同工作树或端口）。

## Decisions

**存储。** `auth.json` 继续保存明文本机 token，这样现有 `?token=` 本机链接和测试不受影响。访问 token 保存在新文件 `access-token.json`（id、明文 secret），第一次在本机查看时生成。两个文件的权限都是 `0600`（Windows 上依赖用户目录权限）。token 是 32 字节随机值的 base64url，熵足够高，校验时比较 SHA-256 哈希，不需要加盐或慢哈希。重新生成同时更换 id，连接和推送订阅都按 id 归属，所以撤销旧 token 与其他进程发现变化走同一条路径。

最近使用时间单独保存，并按分钟节流。放弃写在同一文件：多进程读改写时，过期内存可能让已被替换的 token 复活；最近使用时间丢失一次没有影响。

**多进程。** 校验前比较 `access-token.json` 的修改时间，变化后重新读取，所以 HTTP 和新连接能立即看到其他进程的修改。每个进程每 5 秒也检查一次，断开已被替换 token 的长连接。其他进程的长连接最多延迟约 5 秒断开。放弃文件监听：跨平台行为不一致。

**认证结果。** 每个请求解析出凭据（本机 token 或访问 token 的 id）和是否本机访问，并通过 RPC 上下文传给处理函数。推送订阅和管理接口都读取这个上下文。

**长连接跟踪。** 按凭据登记进行中的 HTTP 响应和已 upgrade 的 socket，结束时移除。token 被替换时全部销毁。放弃按 HTTP socket 跟踪：代理可能在同一条 keep-alive 连接上转发不同用户的请求；而 HTTP/1.1 同一时刻只处理一个响应，销毁响应只影响该请求。

**客户端发现失效。** 不新增 WebSocket 关闭码，因为设备离线时重新生成的情况收不到关闭码。页面连接断开或重连失败时，请求 `GET /api/auth/status`：返回 401 就刷新页面进入登录页；网络错误则保持现状。这一个机制覆盖在线和离线两种情况。

**登录接口。** `POST /api/auth/login` 不经过 token 校验，但要经过同源校验和限速。`POST /api/auth/logout` 经同源校验后清除 Cookie，页面先取消这个浏览器的推送订阅。登录页和首页带内联脚本处理 fragment，分别覆盖未登录和已登录打开链接的情况。无效 Cookie 在响应中清除，避免被反复计入失败。

**查询参数。** `?token=` 只接受本机 token，这样访问 token 不会出现在代理日志中。启动输出第一行的格式不变，现有的就绪解析和测试不用改。

**可信代理。** 新增 `--trusted-proxy <ip>[,<ip>...]` 和 `CODEXHOST_WEB_TRUSTED_PROXIES`，按直连地址精确匹配。`x-forwarded-for` 取最右侧的值，即可信代理观察到的客户端地址。Tailscale Serve 的信任推导由 `add-web-remote-tailscale-access` 提供。放弃布尔开关：无法表达只信任某个代理。

**接口。** 使用现有 RPC：`codexhost/accessTokenGet`、`accessTokenRegenerate`，类型定义在 `shared-contracts`。结果包含明文 secret、最近使用时间和网络地址，页面据此生成二维码和登录链接。网络地址按网卡归类，并通过 `tailscale serve status --json` 检测已转发到当前端口的 HTTPS 地址；只读取，不修改 Serve 配置。非本机时返回错误码 `auth/local-access-required`，并在详情中带 `http://127.0.0.1:<端口>`。页面依据这个错误显示提示，不需要单独的“访问类型”接口。

**界面位置。** 连接设备页是 `ui-codexhost` 中的 React 设置分区，不放进 `HOST_SETTINGS_PAGES`，因为那些页面与 Console 共用，而 Console 没有这个概念。

## Risks / Trade-offs

- [升级后手机全部退出登录] → 这是一次性的；登录页提示到电脑上查看 token。
- [限速按地址计数，经代理且未配置可信代理时，所有用户共用一个地址] → 只影响新登录，已登录设备不受影响；token 熵足够高，限速只是基础保护。
- [同机其他用户或本机程序可以访问回环地址] → 仍然要 token，本机 token 文件只有当前用户可读。
- [持有 token 的人可以通过终端读取本机 token 文件或操作电脑] → 已知限制，本机访问不是严格的安全边界。

## Migration

无需数据迁移。现有 `auth.json` 的值直接成为本机 token，启动时收紧文件权限。回滚时旧版本继续读取 `auth.json`，忽略 `access-token.json`。旧版本会接受任意入口的这个 token，访问 token 则失效。
