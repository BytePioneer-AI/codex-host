# Spec Delta

## Purpose

定义外部客户端如何从本机之外访问 codexhost：权限与网络范围、tailnet 和公网监听、公网入口的 OAuth 配对授权，以及通过厂商 webhook adapter 主动推送停下事件。

## ADDED Requirements

### Requirement: 客户端具有权限范围与网络范围
每个客户端 SHALL 具有权限范围 `read` 或 `dispatch`，以及一个或多个网络范围 `local`、`tailnet`、`public`。`read` 只允许读取、列举、有界等待、列出 watch 与读取事件；`dispatch` 另允许委派、发送、取消与注册 watch。请求 SHALL 在执行前按两种范围检查。`client add` 默认 `dispatch` + `local`；本变更之前登记的客户端 SHALL 视为 `dispatch` + `local`。

#### Scenario: 只读客户端尝试派发
- **WHEN** 权限范围为 `read` 的客户端调用委派创建
- **THEN** 请求 SHALL 以 `FORBIDDEN` 失败，且 MUST NOT 创建 Thread

#### Scenario: 网络范围不允许
- **WHEN** 只允许 `local` 的客户端从 tailnet 地址发起请求
- **THEN** 请求 SHALL 以 `UNAUTHORIZED` 失败，响应与未知令牌相同

#### Scenario: 修改范围
- **WHEN** 用户执行 `codexhost client set <name> --scope read --network local,tailnet`
- **THEN** 新范围 SHALL 对该客户端的后续请求立即生效
- **AND** 收窄网络范围后，不再允许的网络上已建立的事件连接 SHALL 被关闭

### Requirement: tailnet 监听由用户开启
系统 SHALL 提供 tailnet 访问开关，默认关闭。开启后，外部监听 SHALL 同时在本机 Tailscale 地址的同一端口提供与本机监听相同的接口，并只接受网络范围包含 `tailnet` 的客户端。Tailscale 未安装、未登录或地址变化时，系统 SHALL 报告状态并在地址可用后自动恢复监听。tailnet 监听 MUST NOT 绑定到其他网络接口。

#### Scenario: 从另一台 tailnet 设备访问
- **WHEN** 已开启 tailnet 访问，允许 `tailnet` 的客户端从另一台设备请求 `http://<tailscale 地址>:4398/mcp`
- **THEN** 请求 SHALL 以该客户端身份执行

#### Scenario: Tailscale 不可用
- **WHEN** 用户开启 tailnet 访问而本机 Tailscale 未运行
- **THEN** 控制台与诊断 SHALL 显示 tailnet 监听不可用及原因
- **AND** 本机监听与 Desktop SHALL 不受影响

#### Scenario: 不绑定局域网接口
- **WHEN** 已开启 tailnet 访问
- **THEN** 外部监听 MUST NOT 在局域网或公网网卡地址上可达

### Requirement: 公网入口经 Tailscale Funnel 提供 HTTPS
系统 SHALL 提供公网访问开关，默认关闭。开启后，系统 SHALL 通过 Tailscale Funnel 在 HTTPS 下暴露外部监听的一个专用路径，只接受网络范围包含 `public` 的客户端；关闭时 SHALL 移除该映射。系统 MUST NOT 修改或删除用户自己的其他 Tailscale serve 或 funnel 配置。控制台 SHALL 显示公网 URL 与当前状态。

#### Scenario: 开启公网访问
- **WHEN** 用户在 Tailscale 已允许 Funnel 的设备上开启公网访问
- **THEN** 控制台 SHALL 显示形如 `https://<设备名>.<tailnet>.ts.net/codexhost/mcp` 的 MCP 地址
- **AND** 只有允许 `public` 的客户端 SHALL 能通过该地址调用

#### Scenario: 不影响已有映射
- **WHEN** 用户已为其他服务配置了 serve 或 funnel，随后开启再关闭 codexhost 公网访问
- **THEN** 用户的其他映射 SHALL 保持不变

#### Scenario: Funnel 未授权
- **WHEN** tailnet 策略不允许该设备使用 Funnel
- **THEN** 系统 SHALL 报告公网访问不可用及 Tailscale 给出的原因，MUST NOT 尝试其他暴露方式

### Requirement: 公网 MCP 支持以配对码完成的 OAuth 授权
公网入口 SHALL 支持 OAuth 2.1 授权码 + PKCE，供要求 OAuth 的托管 MCP connector 使用。授权页 SHALL 要求输入用户在本机以 `codexhost client pair <name>` 生成的一次性配对码；配对码 10 分钟内有效、只能使用一次。授权成功后签发的访问令牌 SHALL 绑定到该客户端并继承其范围；吊销客户端 SHALL 使其全部访问令牌与刷新令牌失效。

#### Scenario: 托管 bot 完成授权
- **WHEN** 用户在托管 bot 中添加 codexhost MCP 地址，跳转到授权页并输入有效配对码
- **THEN** 授权 SHALL 成功，bot 之后的 MCP 请求 SHALL 以对应客户端身份执行

#### Scenario: 配对码错误或过期
- **WHEN** 授权页收到错误、已用或超过 10 分钟的配对码
- **THEN** 授权 SHALL 失败
- **AND** 同一客户端连续 5 次失败后 SHALL 使当前配对码失效，需要重新生成

#### Scenario: 授权页不泄露信息
- **WHEN** 未完成授权的访问者打开授权页
- **THEN** 页面 MUST NOT 显示客户端列表、Thread、工作目录或任何会话信息

### Requirement: 事件可以通过厂商 webhook adapter 主动推送
用户 SHALL 可以为客户端配置一个 webhook adapter 与目标地址。客户端日志每追加一条事件，系统 SHALL 通过该 adapter 推送；失败 SHALL 按指数退避重试 24 小时，之后标记为投递失败。推送不影响日志：客户端仍可按游标读取全部事件。adapter 负责目标格式与签名，MUST NOT 在 payload 中加入会话内容。首个 adapter SHALL 支持 Grok Bot。

#### Scenario: 推送成功
- **WHEN** 已为 `grok-bot` 配置 Grok Bot adapter，其某个 watch 的 Thread 停下
- **THEN** 系统 SHALL 在事件写入后向目标地址推送 adapter 格式的请求
- **AND** 控制台 SHALL 显示最近一次投递成功的时间

#### Scenario: 目标暂时不可达
- **WHEN** 推送连续失败
- **THEN** 系统 SHALL 按退避重试，同一事件 MAY 被推送多次
- **AND** 超过 24 小时后 SHALL 标记为投递失败并停止重试该事件，后续事件照常推送

#### Scenario: Runtime 重启
- **WHEN** Runtime 在事件推送成功前重启
- **THEN** 恢复后 SHALL 继续推送尚未确认的事件

#### Scenario: 目标拒绝认证
- **WHEN** 目标以 401 或 403 拒绝推送
- **THEN** 系统 SHALL 停止重试该事件并在控制台提示 webhook 配置错误
- **AND** 事件日志 SHALL 不受影响，客户端仍可按游标读取

#### Scenario: payload 保持精简
- **WHEN** adapter 构造推送请求
- **THEN** 请求体 SHALL 不超过 4 KB，只含事件标识、Thread、结果、Harness、深度链接与引用
- **AND** 请求 SHALL 携带可供接收方去重的事件标识

#### Scenario: 换用其他 bot
- **WHEN** 用户把客户端的 adapter 改为另一家
- **THEN** 后续事件 SHALL 按新 adapter 推送，事件日志与游标不变
