# Spec Delta

## MODIFIED Requirements

### Requirement: 登录方式
所有入口 SHALL 使用同一套登录。未登录的页面请求 SHALL 返回登录页，用户可手动输入 token。链接 SHALL 用 URL fragment（`#token=<token>`）携带 token，页面读取后 MUST 从地址栏移除。登录成功后 SHALL 写入 HttpOnly、SameSite=Lax 的 Cookie 记住登录。通过 HTTPS 访问时，Cookie MUST 带 Secure，并使用 `__Host-` 前缀的名字（Path 为 `/`，不设置 Domain）；通过 HTTP 访问时使用不带前缀的名字。

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

#### Scenario: 同一中转域名下的其他子域
- **WHEN** 另一台电脑在同一中转域名下的子域，为父域名设置同名 Cookie
- **THEN** 这台电脑的登录 Cookie 不被覆盖，因为 HTTPS 下使用的 `__Host-` 名字只能由本主机设置

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
- **THEN** 页面默认选中配置的公开地址，其次是已连接的中转地址，再次是已转发到当前端口的 Serve 或 Funnel HTTPS 地址，然后是 Tailscale 地址和局域网地址，并说明每种连接方式的适用范围
- **AND** 虚拟机和容器网卡的地址折叠在“其他地址”中，仍可手动选择；启动输出只在没有其他地址时才列出它们

#### Scenario: 没有可用地址
- **WHEN** Web 只监听本机，也没有 Serve 转发、已连接的中转或公开地址
- **THEN** 页面说明如何允许其他设备访问，并显示可复制的 token

#### Scenario: 确认重新生成
- **WHEN** 用户点击重新生成
- **THEN** 确认时说明其他设备会立即退出、运行中的任务不受影响；确认后页面显示新的二维码

#### Scenario: 未启用认证
- **WHEN** Web 以 `--no-auth` 运行
- **THEN** 页面说明认证未启用，接口返回明确的错误
