# Spec Delta

## Purpose

让用户通过 Tailscale Serve 或自备隧道从其他网络访问 Web，并让电脑端能诊断访问入口、手机端能分清连接问题出在哪里。

## ADDED Requirements

### Requirement: Tailscale 状态
本机访问连接设备页时，Web SHALL 显示这台电脑的 Tailscale 状态：未安装、未运行、未登录、未开启 HTTPS、未转发、根路径已转发到别处或已转发到当前 Web，以及读取失败时的原因。检测 MUST 只读，Web MUST 不修改 Tailscale 配置；未安装时其他连接方式不受影响。

#### Scenario: 未安装 Tailscale
- **WHEN** 这台电脑找不到 `tailscale` 命令
- **THEN** 页面说明未检测到 Tailscale，局域网地址和二维码照常可用

#### Scenario: 未登录
- **WHEN** Tailscale 已安装但需要登录
- **THEN** 页面提示先登录 Tailscale

#### Scenario: 未开启 HTTPS
- **WHEN** Tailscale 已登录，但这台设备没有 HTTPS 能力
- **THEN** 页面提示先在 Tailscale 管理后台开启 HTTPS 证书

#### Scenario: 未转发
- **WHEN** Tailscale 可用，且 HTTPS 443 根路径没有转发
- **THEN** 页面显示转发到当前端口的可复制命令，并说明该配置在 Web 退出后仍保留

#### Scenario: 根路径已转发到别处
- **WHEN** HTTPS 443 根路径已转发到其他目标
- **THEN** 页面显示当前目标，不显示开启命令，因为该命令会替换现有转发

#### Scenario: 已转发到当前 Web
- **WHEN** Serve 的 HTTPS 根路径已转发到当前 Web 的端口
- **THEN** 页面显示该 HTTPS 地址和登录二维码

### Requirement: Funnel 地址标明公开
当检测到的转发地址已通过 Tailscale Funnel 公开到互联网时，Web SHALL 把它标为公开地址，并说明任何人都能访问登录页。

#### Scenario: 根路径同时开启了 Funnel
- **WHEN** 转发到当前 Web 的地址已开启 Funnel
- **THEN** 连接设备页和启动输出把它标为公开地址，登录仍要求 token

### Requirement: 公开地址配置
Web SHALL 接受 `--public-url` 和 `CODEXHOST_WEB_PUBLIC_URL` 作为其他设备访问的地址，`npm start web` 和 `preview.mjs` SHALL 传递它。该值 MUST 是不含用户信息、路径、查询和片段的 `http` 或 `https` 地址，否则 Web 启动失败并说明原因。配置的地址 MUST 不改变可信代理设置，也 MUST 不被当作本机访问。

#### Scenario: 配置 HTTPS 公开地址
- **WHEN** 用户以 `--public-url https://code.example.com` 启动
- **THEN** 启动输出和连接设备页列出该地址，页面默认选中它并生成对应的登录二维码

#### Scenario: 配置 HTTP 公开地址
- **WHEN** 配置的公开地址使用 `http`
- **THEN** 地址可用，页面提示内容以明文传输

#### Scenario: 地址带路径
- **WHEN** 用户以 `--public-url https://example.com/codex` 启动
- **THEN** Web 启动失败，错误说明只支持站点根地址

### Requirement: 启动输出包含转发地址
启动输出 SHALL 列出已转发到当前 Web 的 Serve 地址，且排在 Tailscale IP 和局域网地址之前。读取 Tailscale 状态失败或超时 MUST 不阻止 Web 启动，也 MUST 不改变第一行本机链接的格式。

#### Scenario: 启动时 Serve 已开启
- **WHEN** Serve 已转发到当前端口
- **THEN** 启动输出列出该 HTTPS 地址，终端二维码指向它

#### Scenario: Tailscale 无响应
- **WHEN** 读取 Tailscale 状态超时
- **THEN** Web 正常启动，输出其余地址

### Requirement: 手机端连接状态
Web 会话页面 SHALL 区分并提示：无网络、连接中、电脑离线、Host 不可用、正在恢复。已连接时 MUST 不显示连接提示。网络正常但持续约 10 秒无法到达 Web 时 SHALL 显示电脑离线；短暂中断 MUST 不提示。除 token 失效外，这些状态 MUST 保留已显示的内容和未发送的草稿。token 失效时 SHALL 进入登录页并说明登录已失效。

#### Scenario: 手机没有网络
- **WHEN** 浏览器报告没有网络
- **THEN** 页面提示网络已断开，并显示上次同步时间

#### Scenario: 电脑离线
- **WHEN** 手机有网络，但持续约 10 秒无法连接 Web，包括隧道或 Serve 返回网关错误
- **THEN** 页面提示无法连接到电脑，说明要确认电脑开机且 Web 正在运行，并提供重试

#### Scenario: Web 可达但长连接未恢复
- **WHEN** 登录状态探测成功，但长连接还没有恢复
- **THEN** 页面提示正在重连，不显示电脑离线

#### Scenario: Host 不可用
- **WHEN** Web 可达，但 Host 未就绪或连接已断开
- **THEN** 打开的会话提示 Host 不可用，不显示电脑离线

#### Scenario: 切换网络或锁屏后恢复
- **WHEN** 手机切换网络或从锁屏回到页面，连接恢复
- **THEN** 提示消失，会话补齐断开期间的内容，已显示的消息不重复，未发送的草稿仍在

#### Scenario: 探测无响应
- **WHEN** 登录状态探测在网络切换时一直没有响应
- **THEN** 探测超时并按无法到达处理，之后的探测继续进行

### Requirement: 远程连接说明
本机访问连接设备页时，Web SHALL 提供默认收起的说明，介绍可以通过 Tailscale 或自备隧道从其他网络连接，并给出 Tailscale 下载地址和配置文档链接。该说明 MUST 只介绍当前可用的方式。

#### Scenario: 不了解远程方式的用户
- **WHEN** 用户展开连接设备页的远程连接说明
- **THEN** 页面说明 Tailscale 和自备隧道分别需要什么，以及 `--public-url` 的作用

### Requirement: 自备隧道文档
产品文档 SHALL 说明如何通过 Tailscale Serve、Tailscale Funnel、frp、Cloudflare Tunnel 和 nginx 访问 Web，包括公开地址和可信代理的取值、WebSocket 和事件流的要求、TLS 在哪里解开，以及谁能接触到入口和内容。文档 MUST 说明 Serve 配置在 Web 退出后保留，此时占用同一端口的其他程序会被转发。

#### Scenario: 配置自备隧道
- **WHEN** 用户按文档配置上述任一方式
- **THEN** 文档给出示例配置，并标明该方式是否经过实际运行验证
