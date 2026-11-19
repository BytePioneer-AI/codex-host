# Tasks

依赖 `add-external-client-access`。行为验收见 [remote-client-access](specs/remote-client-access/spec.md)，技术决策见 [design](design.md)。

## 0. 前置验证（先于第 2、4 组）

- [ ] 0.1 用一个临时 MCP 服务经 Tailscale Funnel 暴露，从真实 Grok Bot 添加为自定义 connector，记录它支持的认证方式（静态 header、OAuth 及所需端点）、超时和工具调用行为。结论写入 design 的 Open Questions，只取“成立 / 不成立 / 无法验证”之一并附证据。
- [ ] 0.2 在 Grok Bot 中创建 webhook 触发器，向它发送一次请求，记录 URL 形式、payload 约束、签名或密钥要求，以及触发后 bot 能读取到哪些字段。结论同上。

## 1. 范围

- [ ] 1.1 客户端权限范围与网络范围、`client set`、旧客户端迁移。验证：每个 MCP 工具与 CLI 命令在 `read`/`dispatch` 下的允许矩阵；网络范围拒绝与未知令牌响应一致；收窄范围后连接关闭。

## 2. 监听

- [ ] 2.1 tailnet 入口：地址发现、绑定、地址变化后重绑、不可用状态。验证：从另一台 tailnet 设备调用 MCP；局域网地址不可达；停止 Tailscale 时本机监听不受影响。
- [ ] 2.2 公网入口：独立 loopback 端口、Funnel 路径映射的添加、核对与移除。验证：开关前后用户已有的 serve/funnel 配置不变；公网请求无法以 `local` 身份执行；Funnel 未授权时给出 Tailscale 的原因。

## 3. OAuth

- [ ] 3.1 依据 0.1 的结论实现 OAuth 最小集与 `client pair`。验证：用官方 MCP inspector 走通授权码 + PKCE；配对码过期、重用和 5 次失败失效；吊销客户端后访问令牌与刷新令牌立即失效；授权页不泄露任何列表。

## 4. webhook

- [ ] 4.1 adapter 接口、投递状态持久化与退避重试，`client webhook set|clear`。验证：模拟目标的 2xx/4xx/5xx/超时分类；重启后继续推送未确认事件；24 小时后标记失败且不阻塞后续事件。
- [ ] 4.2 依据 0.2 的结论实现 Grok Bot adapter。验证：真实 Grok Bot 收到推送并被唤醒，随后通过 MCP 读到对应 Thread 的结果。

## 5. 控制台、文档与端到端验收

- [ ] 5.1 控制台显示各入口状态、公网 URL、客户端范围、最近访问和 webhook 投递状态，并提供开关。验证：控制台测试与真实界面截图。
- [ ] 5.2 文档：tailnet、公网、OAuth 配对与 Grok Bot 接入步骤。端到端验收：在手机上向 Grok Bot 下达一个小任务，它经公网 MCP 派发到本机 Codex Thread；Thread 完成后 webhook 唤醒 bot，bot 读取结果并回复。记录平台与版本。
