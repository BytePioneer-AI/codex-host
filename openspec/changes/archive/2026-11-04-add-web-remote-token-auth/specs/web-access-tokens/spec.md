# Spec Delta

## Purpose

Web 的访问认证能力：其他设备用同一个访问 token 从任意入口登录；token 只在本机访问时显示和重新生成；并提供可信代理和基础访问保护。

## ADDED Requirements

### Requirement: 访问 token
Web SHALL 只有一个供其他设备登录的访问 token，它 MUST 由系统生成，并在只有当前用户可读的文件中保存明文；本机访问时 SHALL 可查看和复制。token 不绑定设备或浏览器，也不过期。

#### Scenario: 首次查看
- **WHEN** 用户第一次以本机访问打开连接设备页
- **THEN** 系统生成 token 并持久化，之后刷新页面或重启 Web 服务都显示同一个 token

#### Scenario: 多设备使用同一 token
- **WHEN** 两台设备先后使用该 token 登录
- **THEN** 两台设备都能访问，不需要额外确认

### Requirement: 登录方式
所有入口 SHALL 使用同一套登录。未登录的页面请求 SHALL 返回登录页，用户可手动输入 token。链接 SHALL 用 URL fragment（`#token=<token>`）携带 token，页面读取后 MUST 从地址栏移除。登录成功后 SHALL 写入 HttpOnly、SameSite=Lax 的 Cookie 记住登录，通过 HTTPS 访问时 MUST 带 Secure。

#### Scenario: 打开带 token 的链接
- **WHEN** 手机打开 `https://example/#token=<有效 token>`
- **THEN** 页面完成登录并进入 Web 界面
- **AND** 地址栏不再包含 token，token 也未出现在请求 URL 中

#### Scenario: 重新生成后打开新链接
- **WHEN** 仍保存旧 token 的浏览器打开带当前 token 的链接
- **THEN** 登录切换为当前 token，并从地址栏移除 token

#### Scenario: token 无效
- **WHEN** 用户提交无效 token
- **THEN** 登录页显示错误，不写入 Cookie

### Requirement: 本机访问
只有同时满足以下条件才 SHALL 算本机访问：已通过 token 登录；连接来自回环地址；`Host` 为 `127.0.0.1:<监听端口>` 或 `localhost:<监听端口>`；请求不带 `Forwarded` 和任何 `x-forwarded-*` 头。其他情况 MUST 按非本机处理，即使配置了可信代理。

#### Scenario: 经代理转发的请求
- **WHEN** 请求来自回环地址，但带 `x-forwarded-for`
- **THEN** 按非本机处理

#### Scenario: 隧道转发保留外部 Host
- **WHEN** 请求来自回环地址，`Host` 为隧道的公开域名
- **THEN** 按非本机处理

### Requirement: 本机 token
Web SHALL 维护一个本机 token，保存在只有当前用户可读的文件中。它 MUST 不在界面中展示且不随重新生成改变，并且 MUST 只在满足本机访问中除“已登录”外的其他条件时有效。启动输出的第一行 SHALL 是带本机 token 的本机链接，该链接 SHALL 用查询参数 `?token=`，查询参数只接受本机 token。

#### Scenario: 换浏览器恢复登录
- **WHEN** 用户在另一个本机浏览器打开启动输出中的本机链接
- **THEN** 完成登录并进入 Web 界面，地址栏不再包含 token

#### Scenario: 从其他入口使用本机 token
- **WHEN** 请求经局域网地址或代理携带本机 token
- **THEN** 按无效 token 处理

#### Scenario: 查询参数携带访问 token
- **WHEN** 请求用 `?token=` 携带访问 token
- **THEN** 按无效 token 处理，提示用链接或手动输入登录

### Requirement: 重新生成 token 立即生效
重新生成 token 后 SHALL 立即拒绝使用旧 token 的所有请求，主动断开它建立的 WebSocket、事件流和进行中的 HTTP 请求，并删除它的推送订阅。重新生成 MUST 不停止 Host 上运行中的任务，也 MUST 不影响本机 token 的连接。

#### Scenario: 正在对话时 token 被重新生成
- **WHEN** 一台设备正通过流式连接查看运行中的任务，token 被重新生成
- **THEN** 连接被断开，页面进入登录页
- **AND** 任务继续运行，可由这台电脑或重新登录的设备查看

#### Scenario: 设备离线时 token 被重新生成
- **WHEN** 手机在后台期间 token 被重新生成，之后回到前台
- **THEN** 重新连接失败后页面进入登录页

#### Scenario: 服务暂时不可达
- **WHEN** 页面连接断开，但服务不可达，无法确认 token 状态
- **THEN** 页面保持当前内容和连接状态提示，不进入登录页

#### Scenario: 这台电脑不受影响
- **WHEN** token 被重新生成
- **THEN** 使用本机 token 的连接保持不变

### Requirement: 退出登录
非本机访问的页面 SHALL 提供退出登录，确认时 MUST 说明重新登录需要在电脑上查看 token。退出 SHALL 清除这个浏览器的 Cookie 并取消它的推送订阅，MUST 不影响 token 和其他设备。

#### Scenario: 在借用的设备上退出
- **WHEN** 用户在非本机页面确认退出登录
- **THEN** 页面进入登录页，这个浏览器不再保留登录状态，token 仍然有效

#### Scenario: 跨站请求退出
- **WHEN** 其他站点向退出接口发起请求
- **THEN** 接口拒绝，不清除 Cookie

### Requirement: 连接设备页
Web 设置 SHALL 在所有访问方式下显示“连接设备”入口。本机访问时 SHALL 显示所选地址的登录二维码和链接、最近使用时间，并可复制链接和 token、重新生成 token。非本机访问时 MUST 不显示 token，并提示只有在这台电脑上通过 `http://127.0.0.1:<端口>` 访问才能查看；接口 MUST 拒绝并返回明确的错误。

#### Scenario: 手机打开连接设备页
- **WHEN** 手机通过局域网或代理打开连接设备页
- **THEN** 显示本机访问提示和退出登录，不显示 token

#### Scenario: 非本机直接调用接口
- **WHEN** 非本机访问调用查看或重新生成接口
- **THEN** 接口拒绝，不返回任何 token 信息，也不修改数据

#### Scenario: 选择连接地址
- **WHEN** 这台电脑有多个可用地址
- **THEN** 页面默认选中已转发到当前端口的 Tailscale Serve HTTPS 地址，其次是 Tailscale 地址和局域网地址，并说明每种连接方式的适用范围
- **AND** 虚拟机和容器网卡的地址折叠在“其他地址”中，仍可手动选择；启动输出只在没有其他地址时才列出它们

#### Scenario: 没有可用地址
- **WHEN** Web 只监听本机，也没有 Serve 转发
- **THEN** 页面说明如何允许其他设备访问，并显示可复制的 token

#### Scenario: 确认重新生成
- **WHEN** 用户点击重新生成
- **THEN** 确认时说明其他设备会立即退出、运行中的任务不受影响；确认后页面显示新的二维码

#### Scenario: 未启用认证
- **WHEN** Web 以 `--no-auth` 运行
- **THEN** 页面说明认证未启用，接口返回明确的错误

### Requirement: 可信代理
Web SHALL 默认忽略 `x-forwarded-*`。只有直连地址命中显式配置的可信代理地址时，才 SHALL 用这些头判断客户端地址、外部 Host（同源校验）和协议（Cookie 的 Secure）。

#### Scenario: 未配置可信代理
- **WHEN** 未配置可信代理的请求带伪造的 `x-forwarded-host`
- **THEN** 同源校验只使用 `Host`

#### Scenario: 配置了可信代理
- **WHEN** 来自可信代理的请求带 `x-forwarded-host` 和 `x-forwarded-proto: https`
- **THEN** 同源校验使用外部 Host，登录 Cookie 带 Secure

### Requirement: 登录失败限速
携带无效 token 的请求 SHALL 按客户端地址计数；同一地址一分钟内失败 10 次后，该地址接下来一分钟内的登录和无效 token 请求 SHALL 返回 429。携带有效 Cookie 或 Bearer 的请求 MUST 不受限速影响。

#### Scenario: 连续输错 token
- **WHEN** 同一地址一分钟内提交 10 次无效 token 后再次提交
- **THEN** 返回 429，登录页提示稍后再试

#### Scenario: 已登录设备不受影响
- **WHEN** 某地址被限速时，同一地址上另一台已登录设备发起请求
- **THEN** 请求正常处理

### Requirement: 用户文件不作为同源页面执行
所有响应 SHALL 带 `X-Content-Type-Options: nosniff`。直接返回本机文件内容的接口 MUST 只返回允许的栅格图片类型，不能返回 HTML 或 SVG。HTML 文档预览 MUST 运行在无同源权限的沙箱中，无法读取 Cookie 或调用 Web 接口。

#### Scenario: 请求本机 HTML 文件
- **WHEN** 已登录用户通过文件接口请求一个 `.html` 或 `.svg` 文件
- **THEN** 接口拒绝，不返回文件内容

#### Scenario: 预览含脚本的 HTML
- **WHEN** 用户预览一个含脚本的 HTML 文件
- **THEN** 脚本无法访问 Web 的同源接口和 Cookie

### Requirement: 推送订阅归属
Web Push 订阅 SHALL 关联到创建它的 token。启用认证后，没有归属的已有订阅 MUST 被丢弃。已开启通知的浏览器 SHALL 在打开页面时重新提交订阅，使其关联到当前 token。

#### Scenario: 重新生成 token 后不再推送
- **WHEN** token 被重新生成
- **THEN** 使用旧 token 的设备不再收到通知

#### Scenario: 重新登录后恢复通知
- **WHEN** 已开启通知的设备用重新生成的 token 登录
- **THEN** 该设备的订阅关联到新 token，并继续收到通知

### Requirement: 对外监听
`npm start web` 和 `preview.mjs` SHALL 默认监听 `0.0.0.0`，访问由 token 保护；`--host` 可以限定监听地址。对外监听时，启动输出和连接设备页的网络地址 MUST 不包含本机 token，并 SHALL 提示局域网 HTTP 为明文传输。

#### Scenario: 默认启动
- **WHEN** 用户不带 `--host` 运行 `npm start web`
- **THEN** 局域网设备可以连接，未登录时只能看到登录页
- **AND** 启动输出列出不带 token 的网络地址和明文提示

#### Scenario: 限定为本机
- **WHEN** 用户以 `--host 127.0.0.1` 启动
- **THEN** 局域网设备无法连接
