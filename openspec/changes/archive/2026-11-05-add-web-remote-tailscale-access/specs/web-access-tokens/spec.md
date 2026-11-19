# Spec Delta

## MODIFIED Requirements

### Requirement: 可信代理
Web SHALL 默认忽略 `x-forwarded-*`。只有直连地址命中可信代理时，才 SHALL 用这些头判断客户端地址、外部 Host（同源校验）和协议（Cookie 的 Secure）。可信代理来自显式配置；Tailscale Serve 根路径转发到当前 Web 期间，回环地址也 SHALL 算作可信代理，转发撤销后约 30 秒内 MUST 恢复。经可信代理的请求 MUST 不算本机访问。

#### Scenario: 未配置可信代理
- **WHEN** 未配置可信代理，也没有 Serve 转发，请求带伪造的 `x-forwarded-host`
- **THEN** 同源校验只使用 `Host`

#### Scenario: 配置了可信代理
- **WHEN** 来自可信代理的请求带 `x-forwarded-host` 和 `x-forwarded-proto: https`
- **THEN** 同源校验使用外部 Host，登录 Cookie 带 Secure

#### Scenario: 经 Serve 登录
- **WHEN** 已检测到 Serve 转发到当前 Web，手机经 Serve 的 HTTPS 地址登录
- **THEN** 登录 Cookie 带 Secure，登录失败按手机的 tailnet 地址计数，一台设备输错不影响其他设备

#### Scenario: Serve 转发已撤销
- **WHEN** 用户移除转发约 30 秒后，回环地址上的请求带 `x-forwarded-proto: https`
- **THEN** 这些头被忽略，登录 Cookie 不带 Secure

#### Scenario: 经 Serve 的请求不算本机
- **WHEN** 经 Serve 转发的请求查看 token
- **THEN** 接口拒绝，返回本机访问提示

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
- **THEN** 页面默认选中配置的公开地址，其次是已转发到当前端口的 Serve 或 Funnel HTTPS 地址，再次是 Tailscale 地址和局域网地址，并说明每种连接方式的适用范围
- **AND** 虚拟机和容器网卡的地址折叠在“其他地址”中，仍可手动选择；启动输出只在没有其他地址时才列出它们

#### Scenario: 没有可用地址
- **WHEN** Web 只监听本机，也没有 Serve 转发或公开地址
- **THEN** 页面说明如何允许其他设备访问，并显示可复制的 token

#### Scenario: 确认重新生成
- **WHEN** 用户点击重新生成
- **THEN** 确认时说明其他设备会立即退出、运行中的任务不受影响；确认后页面显示新的二维码

#### Scenario: 未启用认证
- **WHEN** Web 以 `--no-auth` 运行
- **THEN** 页面说明认证未启用，接口返回明确的错误
