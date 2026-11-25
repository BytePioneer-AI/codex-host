# Proposal

## Why

委派和 Thread 操作现在只对 Host 自己拉起的进程开放：Runtime 端点是随机端口，令牌只出现在这些进程的环境里，调用方身份也只能是一个 Thread。本机上不由 Host 启动的进程（终端里的脚本、Claude Desktop、常驻 bot 的本机代理）无法派发任务、追问或得到完成通知，只能各自重造一套派发和回收。同时，任务从哪里来（issue、需求）和哪个 Thread 在做它之间没有可查询的关联。

## What Changes

- 新增**外部客户端**：`codexhost client add|list|remove` 登记有名字的客户端并签发令牌，删除即吊销。
- Runtime 增加一个面向外部客户端的本机监听，固定端口（可配置），并写出仅当前用户可读、不含令牌的端点描述文件。CLI 在没有 Host 提供的连接参数、但给了客户端令牌时，通过它连接；Host 拉起的进程行为不变。
- 外部客户端可调用现有全部委派与 Thread 操作。不指定父 Thread 发起的委派以该客户端为来源，`thread list --client <name>` 可列出。这些 Thread 和其他 Thread 一样出现在 Desktop 侧栏；按客户端分组另行提案。
- 新增 Thread **引用**：`delegate start --ref <uri>` 可重复，子委派继承父 Thread 的引用；`thread read`/`list` 返回引用，`thread list --ref <uri>` 按引用过滤。
- 新增按客户端的**持久事件日志**：被通知方为客户端的 watch 在 Thread 停下时写入事件。客户端通过 SSE 实时接收，或用 long-poll 补拉；事件默认保留 7 天（可配置），游标由客户端持有。
- 同一组操作以 **MCP** 工具提供，任何支持 HTTP MCP 的本机客户端都可以直接接入。

## Decisions

- **客户端是独立身份，不是 Thread。** 外部调用方没有 Turn 可以接收通知，借用某个 Thread 当父会混淆血缘，通知也到不了调用方本人。
- **外部监听与 Host 内部控制端口分开。** 内部端口和令牌继续只给 Host 拉起的进程，现有安全边界不变；外部监听需要固定地址，才能写进 MCP 客户端配置，后续远程提案也只放开这一个监听。
- **客户端以 `client:<name>` 作为父来源，写进普通的 Delegation 关系；引用另存。** 幂等、`--client` 列举与回滚兼容都沿用既有路径，不新增记录格式：Delegation 记录是严格的 v1 格式，标识本身是不透明字符串，旧版本读到的只是一个不存在的父 Thread。同一个 `client:<name>` 也是客户端 watch 的被通知方。引用需要新字段，因此按 Thread 另存，旧版本忽略。
- **SSE 为主，long-poll 保底，二者共用同一份持久日志。** 主动推送更符合 agent 协作的节奏；断线、休眠或 Runtime 重启后，按游标补拉即可，不丢事件。
- **事件只报告执行状态，与 watch 通知同一原则。** 不带会话内容，客户端需要结果时再 `thread read`。
- 不在本提案内：tailnet 与公网访问、权限范围、webhook 推送（见 `add-remote-client-access`），以及客户端分组显示。

## Capabilities

### New Capabilities

- `external-client-access`：外部客户端的登记与吊销、本机发现与认证、事件日志与推送、MCP 接入。

### Modified Capabilities

- `cross-harness-delegation`：运行时连接允许以客户端令牌连接外部监听；委派来源可以是客户端；新增 Thread 引用，以及列举时按客户端和按引用过滤。

## Impact

`packages/host-runtime`（外部监听、客户端登记、事件日志、MCP、CLI 子命令）、Thread 引用的私有存储、`shared-contracts`（事件与 MCP 工具结构），以及委派帮助文本与随附 Skill。依赖 `persist-thread-watches`：客户端 watch 同样需要持久化。MCP 服务端按 Streamable HTTP 的最小子集自行实现，不给 Host 核心新增依赖。
