# Spec Delta

## MODIFIED Requirements

### Requirement: Tailscale 状态
本机访问连接设备页时，Web SHALL 显示这台电脑的 Tailscale 状态：未安装、未运行、未登录、未开启 HTTPS、未转发、根路径已转发到别处或已转发到当前 Web，以及读取失败时的原因。状态检测 MUST 只读；只有用户在本机确认开启或关闭 Serve 时，Web 才 SHALL 修改 Tailscale 配置；未安装时其他连接方式不受影响。

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
- **THEN** 页面提供开启开关；确认弹窗提供转发到当前端口的可复制命令，并说明该配置在 Web 退出后仍保留

#### Scenario: 根路径已转发到别处
- **WHEN** HTTPS 443 根路径已转发到其他目标
- **THEN** 页面显示当前目标，不显示开启命令，因为该命令会替换现有转发

#### Scenario: 已转发到当前 Web
- **WHEN** Serve 的 HTTPS 根路径已转发到当前 Web 的端口
- **THEN** 页面显示该 HTTPS 地址和登录二维码

## ADDED Requirements

### Requirement: 一键开关 Tailscale Serve
用户在本机确认后，Web SHALL 能开启和关闭 Tailscale Serve。开启前 MUST 重新读取状态，根路径已转发到别处时 MUST 不覆盖。关闭 MUST 只移除指向当前 Web 的根路径，MUST 不影响其他路径和其他端口。操作结果 MUST 以重新读取的状态为准，命令退出成功而配置未生效时 SHALL 显示失败。Web 退出、`codexhost stop` 和更新 MUST 不撤销 Serve。非本机访问 MUST 不能使用此操作。

#### Scenario: 开启
- **WHEN** Tailscale 可用且根路径没有转发，用户在本机确认开启
- **THEN** 页面显示已转发，并默认选中 Tailscale HTTPS 地址

#### Scenario: 确认时根路径已被占用
- **WHEN** 页面显示未转发后，根路径被其他程序占用，用户再确认开启
- **THEN** 不修改配置，页面显示当前目标

#### Scenario: 命令成功但没有生效
- **WHEN** 开启命令退出成功，重新读取的状态仍未转发
- **THEN** 页面显示开启失败和当前状态

#### Scenario: 关闭
- **WHEN** 根路径转发到当前 Web，同一端口还有其他路径，用户确认关闭
- **THEN** 只移除根路径，其他路径保留

#### Scenario: 根路径转发到别处时关闭
- **WHEN** 根路径转发到其他目标
- **THEN** 页面不提供关闭操作

#### Scenario: 非本机请求
- **WHEN** 手机或经代理的请求调用开启或关闭
- **THEN** 接口拒绝，返回本机访问提示，不修改配置

#### Scenario: 停止服务后
- **WHEN** 用户开启过 Serve，然后运行 `codexhost stop`
- **THEN** Serve 配置保留，再次启动 Web 后手机沿用原地址
