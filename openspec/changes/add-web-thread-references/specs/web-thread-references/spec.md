## Purpose

让 Web 用户通过已有会话标识或侧栏拖动，在当前消息中表达准确的历史会话引用。引用只携带定位信息，历史读取继续由当前 Agent 使用既有 codexhost 能力完成，不建立新的会话副本或执行通道。

## ADDED Requirements

### Requirement: 拖入历史会话显示蓝色行内引用
Web SHALL 允许将侧栏已存在的本地共享 CH 外部 Thread 拖入聊天主区域（含输入框），在当前 Composer 显示蓝色「会话图标 + 标题」行内引用并保留 canonical Thread ID 与显式 local 来源。标题 SHALL 仅用于展示，无标题时 SHALL 使用短 ID。该操作 MUST NOT 打开目标、提交消息、读取历史或改变侧栏排序，且 SHALL 保留现有草稿与附件。

#### Scenario: 拖入已有草稿
- **WHEN** 用户将一个本地共享外部 Thread 拖入已有文字和附件的当前输入框
- **THEN** 草稿 SHALL 在插入位置显示蓝色会话图标与标题，而不是展开完整链接
- **AND** 原有正文与附件 SHALL 保留，当前会话与侧栏顺序 SHALL 不变
- **AND** 引用 SHALL 可与正文混排、整体删除并撤销插入

#### Scenario: 聊天主区域的明显拖入反馈
- **WHEN** 有效的本地共享外部 Thread 拖动进入可编辑会话的聊天主区域
- **THEN** 整个可接收聊天区域 SHALL 显示浅蓝色高亮覆盖、“松开以引用聊天”及会话图标与标题预览
- **AND** 在正文、留白或输入框松开 SHALL 仅向当前 Composer 插入一次引用，保留原草稿、附件与编辑位置，不发送、跳转或读取

#### Scenario: 拖入反馈清理与来源限制
- **WHEN** 拖动在区域内跨子元素移动、离开区域、取消或结束
- **THEN** 跨子元素移动 MUST NOT 导致高亮闪烁，离开、取消、结束及目标卸载后 SHALL 清理反馈
- **AND** 文件拖动、未支持来源或不可编辑目标 MUST NOT 显示会话引用高亮或被会话引用流程接管

#### Scenario: 行内引用发送
- **WHEN** 用户发送包含蓝色行内引用的消息
- **THEN** 引用 SHALL 以形如 `[@标题](thread://<id>?hostId=local)` 的标准文本链接交给 Agent
- **AND** 标题中的特殊字符 MUST NOT 改变目标地址或注入额外链接
- **AND** 已发送用户消息与队列预览中的显式 `[@标题](thread://<id>?hostId=...)` SHALL 显示蓝色会话图标与标题，而非整段 Markdown；悬停保留原始链接信息，消息复制、队列编辑及历史原文 SHALL 保留完整 ID 与来源，不新增读取或跳转行为

#### Scenario: 同名会话和多个引用
- **WHEN** 用户依次拖入两个标题相同但 ID 不同的 Thread
- **THEN** 草稿 SHALL 保留各自真实 ID 的两个行内引用，不按标题合并

#### Scenario: 未支持来源或未创建草稿
- **WHEN** 侧栏条目属于隔离 Web Codex、其他未支持来源或尚未创建的草稿
- **THEN** Web MUST NOT 为其生成冒充本地共享 CH Thread 的引用

#### Scenario: 与既有拖放共存
- **WHEN** 用户拖放文件到输入框，或在侧栏执行原有排序
- **THEN** 对应既有行为 SHALL 保持，不被会话引用处理接管

### Requirement: 会话菜单可复制标准链接
Web SHALL 在本地共享 CH 外部 Thread 的会话菜单提供“复制会话链接”，将 `thread://<id>?hostId=local` 写入剪贴板，与拖动引用使用相同目标地址。复制 SHALL 不改变当前会话或草稿，不读取历史；成功与失败 SHALL 明确提示。不支持的来源与未创建草稿 MUST NOT 提供冒充共享 CH 引用的复制操作。

#### Scenario: 复制成功并粘贴
- **WHEN** 用户选择受支持会话的“复制会话链接”且剪贴板写入成功
- **THEN** Web SHALL 提示“已复制”，剪贴板 SHALL 包含该会话的真实 ID 与 local 来源
- **AND** 粘贴到输入框后 SHALL 沿用普通文本语义，不要求自动转换为蓝色引用

#### Scenario: 剪贴板写入失败
- **WHEN** 浏览器拒绝或无法完成剪贴板写入
- **THEN** Web SHALL 明确提示复制失败，MUST NOT 显示成功或改变草稿

### Requirement: 手工引用与拖入引用沿用文本提交
Web SHALL 保留用户粘贴的裸 ID、`codex://threads/<id>`、`thread://<id>?hostId=...` 及其 Markdown 链接，通过既有文本提交路径发送。Web MUST NOT 根据标题猜测身份、自动改写显式来源、查询全文或追加工具调用指令。引用 SHALL 沿用普通文本的草稿、队列与失败恢复语义。

#### Scenario: 粘贴链接或 ID
- **WHEN** 用户粘贴裸 ID 或受支持形式的会话链接并发送
- **THEN** Agent 收到的用户正文 SHALL 保留该标识及已有来源信息
- **AND** Web MUST NOT 为裸 ID 自动补充猜测的来源或将普通 UUID 转成特殊引用

#### Scenario: 显式其他来源
- **WHEN** 用户粘贴带有非 local hostId 的链接
- **THEN** Web SHALL 原样保留来源，MUST NOT 将其改成本地引用或宣称读取成功

#### Scenario: 排队编辑与发送失败
- **WHEN** 带有引用链接的消息进入队列后被编辑，或发送被明确拒绝
- **THEN** 引用 SHALL 与正文一起沿用既有回填或保留行为，不丢失真实 ID
- **AND** 提交结果未知时 MUST NOT 因包含引用而自动重发

### Requirement: 引用复用既有只读访问能力
会话引用 SHALL 仅表达目标身份，不包含目标历史或改变目标执行状态。当前 Agent 在用户要求读取时 SHALL 能使用既有 CLI 和 Runtime 权限读取受支持的本地共享外部 Thread。Web MUST NOT 通过引用操作自动向目标发送消息、取消任务或扩大权限；读取范围及错误 SHALL 保持既有 CLI 语义。

#### Scenario: 明确请求读取历史
- **WHEN** 在 CLI 与 Runtime 可访问的共享外部 Harness 会话中，用户发送“读取这个会话并总结”及另一个可读取的本地共享外部 Thread 引用，Agent 调用现有读取能力
- **THEN** 读取 SHALL 定位到引用的真实 Thread 并返回既有可见消息或结果
- **AND** 被引用 Thread MUST NOT 因此启动新的 Turn

#### Scenario: 读取不可用
- **WHEN** Agent 按引用读取但目标不存在、Runtime 不可访问或权限不允许
- **THEN** 既有读取错误 SHALL 保留，MUST NOT 通过另一个来源或同名 Thread 替代
- **AND** 引用的存在 MUST NOT 被表示为已取得目标内容
