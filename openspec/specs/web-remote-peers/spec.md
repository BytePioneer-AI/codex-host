# web-remote-peers Specification

## Purpose
TBD - created by archiving change optimize-remote-peer-layered-reuse. Update Purpose after archive.
## Requirements
### Requirement: Peer 会话事件驱动同步
Web SHALL 依据 Peer 的实时事件刷新其会话列表与已打开的会话，MUST NOT 以固定间隔轮询会话历史。事件流断开时会话 SHALL 显示重连状态并保留已显示内容；恢复后 SHALL 补齐断开期间的变化，不重复已显示消息。只有流式文本或工具增量的事件 MUST NOT 触发列表刷新。

#### Scenario: 远端产生新回合
- **WHEN** 用户正在查看某个 Peer 会话，远端该会话完成一个新回合
- **THEN** 新内容在事件到达后出现，期间没有周期性历史读取

#### Scenario: Peer 重连
- **WHEN** Peer 事件流断开后恢复，期间该会话追加了两个回合
- **THEN** 两个回合都出现且不重复，重连提示消失

### Requirement: Peer 历史增量加载
打开 Peer 会话时 Web SHALL 只读取最新一页回合即可显示，较早历史在用户向上浏览时按页加载。再次读取时已持有且未变化的回合 SHALL 复用，不重新传输。历史长度 MUST NOT 导致打开失败。历史被改写时 SHALL 重建视图而不是拼接旧内容。

#### Scenario: 超长历史
- **WHEN** 用户打开一个有数百个回合的 Peer 会话
- **THEN** 最新回合先显示，向上滚动时逐页补齐，不出现“历史过大”错误

#### Scenario: 远端回滚
- **WHEN** 远端回滚了已显示的最后一个回合
- **THEN** 会话显示回滚后的权威历史，不保留被回滚的回合

### Requirement: Peer Harness 归属与目录缓存
Peer 会话行 SHALL 显示远端 Host 确认的 Harness 归属。Web SHALL 按 Peer 缓存其 Harness 列表与检查结果，仅在该 Peer 重启或宣告检查变化时失效；读取会话 MUST NOT 每次重新探测全部 Harness 或重复下载图标数据。Peer 的目录 MUST NOT 混入本机或其他 Peer 的 Harness。

#### Scenario: 侧栏显示归属
- **WHEN** Peer 上有 Claude Code 与 Codex 两个会话
- **THEN** 侧栏两行分别显示 Claude Code 与 Codex 的身份，无需先打开会话

#### Scenario: 重复打开会话
- **WHEN** 用户在同一 Peer 上依次打开多个会话
- **THEN** Harness 列表与检查结果复用缓存，直到该 Peer 重启或宣告检查变化

#### Scenario: Peer 草稿的模型目录
- **WHEN** 用户在 Peer 项目中新建草稿并打开模型选择
- **THEN** 列出该 Peer 已就绪的 Harness 与模型，不包含本机 Harness

### Requirement: Peer Harness 图标
Web SHALL 为 Peer 会话显示该 Peer 提供的 Harness 图标，由本机按 Peer 代理并缓存。Codex 图标 SHALL 使用本机资源。Peer 离线或图标缺失时 SHALL 显示通用图标，MUST NOT 用本机同 ID Harness 的图标冒充。

#### Scenario: 远端独有 Harness
- **WHEN** Peer 安装了本机没有的 Harness 并有其会话
- **THEN** 侧栏和模型选择显示该 Peer 提供的图标

#### Scenario: Peer 离线
- **WHEN** Peer 离线时浏览器请求其图标
- **THEN** 显示通用图标，页面其他部分不受影响

### Requirement: Peer 附件能力门控
只有当 Peer 声明支持附件且处于已连接状态时，Web SHALL 为该 Peer 的会话和草稿开启附件输入与图片预览；否则 SHALL 关闭附件入口，图片路径不显示为可打开的图片。能力 MUST 以 Peer 的声明为准，MUST NOT 依据版本号推断。Codex Desktop 远程会话 MUST 保持附件关闭。

#### Scenario: 未升级的 Peer
- **WHEN** Peer 未声明附件能力
- **THEN** 会话可正常查看与发送文字，附件按钮不可用

#### Scenario: 升级后的 Peer
- **WHEN** Peer 声明附件能力并已连接
- **THEN** 会话和草稿的附件按钮可用，图片限制与本机一致

### Requirement: Peer 附件上传与提交
Peer 会话的附件 SHALL 在选择时直接上传到该 Peer，并沿用本机的上传进度、上传中发送与失败恢复体验。已有会话的凭证 SHALL 只归属该远端会话；草稿的凭证 SHALL 在首条消息创建会话后归属新会话。提交 SHALL 由 Peer 按排队或引导等模式处理，与本机提交语义一致。凭证 MUST NOT 跨会话或跨 Peer 使用；不支持编码图片的提交 MUST 被拒绝且不部分发送。

#### Scenario: 已有会话发送图片
- **WHEN** 用户在空闲的 Peer 会话中附带一张图片发送
- **THEN** 远端 Harness 收到该图片，转录区显示图片缩略图

#### Scenario: 草稿首条消息带文件
- **WHEN** 用户在 Peer 草稿中附带文件发送首条消息
- **THEN** 远端创建会话并收到该文件，草稿切换为正式会话

#### Scenario: 创建成功但提交失败后重试
- **WHEN** 首条消息已创建远端会话但提交失败，用户在同一会话中重试
- **THEN** 已上传的附件仍可使用，无需重新选择

#### Scenario: 凭证属于其他会话
- **WHEN** 提交引用了另一个 Peer 会话的上传凭证
- **THEN** 提交被拒绝并提示重新选择文件，消息不部分发送

### Requirement: Peer 图片预览
Web SHALL 能预览 Peer 会话中的用户图片附件与回复中引用的图片，图片字节由 Peer 读取。Peer MUST 只返回位于该会话工作目录或其 Web 附件存储内的图片文件，拒绝其他路径、非图片和超限文件且不泄露路径信息。远端路径 MUST NOT 被本机当作本机文件读取。

#### Scenario: 回复引用工作目录内的截图
- **WHEN** Assistant 回复引用了远端工作目录内的一张截图
- **THEN** 用户可以打开该图片

#### Scenario: 引用工作目录外的文件
- **WHEN** 回复引用了远端工作目录外的路径
- **THEN** 图片显示为无法加载，本机同名路径不会被读取

### Requirement: Peer 兼容边界
Peer 读路径 SHALL 只依赖已有的版本化客户端通道；Peer 缺少会话目录或委派树读取时 SHALL 回退为现有列表行为（不显示归属树）而不报错。Codex Desktop 远程会话的列表、历史与发送行为 MUST 保持不变。写操作（创建、发送、排队、引导、配置、中断、改名、归档、审批应答）的确认语义 MUST 保持不变。

#### Scenario: 旧版 Peer
- **WHEN** Peer 的 Host 不支持会话目录读取
- **THEN** 侧栏仍列出其会话，只是不显示委派树

#### Scenario: Desktop 远程并存
- **WHEN** 同时存在 Peer 与 Codex Desktop 远程主机
- **THEN** Desktop 远程会话的行为与变更前一致

