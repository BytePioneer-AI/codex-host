# Proposal

## Why

远端主机（Peer）目前通过一套独立的“操作”通道读取会话：打开会话要整段遍历历史，跟随靠 1.5 秒轮询，每次读取都附带 N+1 次 Harness 探测和含 base64 图标的插件列表；侧栏拿不到 Harness 归属与委派树，Peer 会话也不能发送附件或预览图片。本机直连已经有事件驱动、增量首屏、按 Host 缓存目录的成熟实现，Peer 应复用同一套，而不是继续维护平行实现。

## What Changes

- **读路径分层复用（Phase 1，兼容未升级远端）**：每个 Peer 以版本化的 `/api/ch/v1/*` 作为与本机直连相同的 Host 客户端接口，复用直连的实时失效、增量历史（已知 Turn 占位、首屏 5 个 Turn、按需翻页）、Harness 目录缓存（按节点与 epoch）、自带 Harness 归属的会话目录读取，以及委派树读取。
- Peer 会话的跟随改为事件驱动，取消 1.5 秒轮询；历史不再整段遍历，取消“历史过大”上限错误。
- 侧栏 Peer 会话显示真实 Harness 图标；本机新增 `/harness-icons/peer/<peerId>/<harnessId>` 与对应 `presentation.json`，从该节点的缓存目录提供。
- Web 侧栏对同一 Peer 内的委派关系建树（含祖先补齐与归档级联），不再一刀切屏蔽远程树；跨主机仍不建立父子关系。
- **附件与图片预览（Phase 2，manifest 能力门控）**：远端新增 `POST /api/peer/v1/uploads`、`POST /api/peer/v1/prompt`、`GET /api/peer/v1/file`，并在 manifest 中声明 `capabilities.attachments = 1`；本机按会话所属 Peer 透传上传流、带凭证的发送和图片读取，仅在能力确认后开启 Peer 会话与草稿的附件输入及图片预览。
- Codex Desktop 远程（非 `remote-peer:` 主机）保持现有兼容路径不变。

## Decisions

- **只换读路径，写路径不动。** 创建、发送、排队、引导、配置、中断、改名、归档、审批应答继续走已验证幂等与确认语义的现有操作；Phase 1 只替换列表、历史、跟随、目录与图标。放弃：一次性把 Peer 改造成完整的直连会话管理器（ID、工作区分组与草稿归属差异太大）。
- **附件按远端会话归属。** 已有 Thread 的上传直接归属该远端 Thread；未提交草稿使用本机生成的一次性上传范围，首条消息创建 Thread 后在远端绑定到该 Thread 再提交。放弃：在本机暂存再转传（发送时二次上传、凭证命名空间混乱），以及提前在远端创建草稿或空 Thread（会出现在远端用户的侧栏）。
- **能力由 manifest 声明，不靠版本号推断。** 未声明能力的 Peer 保持附件关闭；Phase 1 只依赖已有接口，远端缺少目录或树读取方法时回退到现有行为。
- **远端路径永不进入本机文件读取。** 图片与附件只经 Peer 专用代理读取，由远端按其 Thread 工作目录和 Web 附件存储校验。

## Capabilities

### New Capabilities

- `web-remote-peers`：Web 聚合远端 Peer 会话的同步、历史、Harness 归属与图标、附件上传与图片预览，以及与未升级 Peer、Desktop 远程的兼容边界。

### Modified Capabilities

- `web-thread-tree`：多层树显示扩展到同一 Peer 内的委派关系。

## Impact

- `packages/shared-contracts`：Peer manifest 能力字段，Peer 上传、发送、文件读取的请求与结果 schema，Peer 图标与文件代理路径。
- `packages/web-server`：Peer Host 客户端、Peer 会话数据源、远端会话门面的 Peer 读路径与附件接入、Peer 端新增三个端点、本机图标与文件代理路由；`ChThreadHistory` 增加 Host 侧 Thread 标识选项。
- `apps/web-ui`：侧栏树的同节点规则、Peer 图标地址、Peer 会话图片预览地址。
- 不新增依赖与持久化格式；Peer 配置文件不变。
