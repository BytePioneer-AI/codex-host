## ADDED Requirements

### Requirement: 全局用量统计必须按请求去重

Host 汇总本机全局用量时 MUST NOT 把各会话的累计结果直接相加。读取器 MUST 为每条记录给出在该 Harness 内稳定的记录 ID，分叉或恢复复制的同一请求 MUST 保持相同 ID；Host MUST 按（Harness, 记录 ID）只计一次。原生副本无法保持相同 ID 或原始请求时间时，读取器 MUST 按该 Harness 的原生分叉规则排除复制的历史，MUST NOT 把分叉时间当作原请求时间。

#### Scenario: 分叉会话复制了父会话历史

- **WHEN** 一个原生会话由另一个会话分叉而来，并在其存储中复制了父会话已有的请求
- **THEN** 这些请求在全局统计中 MUST 只计一次
- **AND** 分叉之后新产生的请求 MUST 正常计入

#### Scenario: Qoder 分叉改写复制行的时间

- **WHEN** Qoder 或 Qoder CN 的原生分叉行带有 `forkedFrom`，且原始请求文件仍在本机
- **THEN** 读取器 MUST 跳过这些复制行，由原始记录提供请求时间与用量
- **AND** 原始文件缺失时 MUST NOT 猜测复制行的原始发生日期

### Requirement: 全局费用必须按模型 ID 读时计价

全局统计的费用 MUST 在读取时用 Host 当前价格目录（打包的 models.dev 快照、其刷新结果与用户 `pricing.json`）按模型 ID 计算，表示按官方公开价的 API 等价费用。无法计价的请求 MUST NOT 计入费用；存在未计价请求时，费用 MUST 作为下限呈现，并列出未计价的模型 ID。

#### Scenario: 用户为未计价模型补充价格

- **WHEN** 某模型此前无价格，用户随后在 `pricing.json` 为该模型 ID 设置价格
- **THEN** 下次读取统计时，该模型的历史请求 MUST 按新价格计入费用

### Requirement: 全局统计必须只读原生存储

读取原生会话用量时，读取器 MUST 只读原生文件或数据库，MUST NOT 修改、删除或迁移原生会话存储，MUST NOT 启动原生进程或模型 Turn。Host MUST NOT 为全局统计另起独立进程，读取与汇总 MUST 在已运行的 Host Runtime 内完成且不得阻塞其他 Host 请求。Host 保存的解析缓存 MUST 是可删除、可从原生存储重建的派生数据。

#### Scenario: 解析缓存被删除

- **WHEN** Host 数据目录中的全局统计缓存不存在或格式版本不匹配
- **THEN** Host MUST 从原生存储重新解析并得到与删除前相同的统计结果

### Requirement: 全局统计必须覆盖本机全部原生会话并以原生时间归日

全局统计 MUST 覆盖本机官方 Codex 与实现了用量读取能力的 Harness 的全部原生会话，不论其是否经 CodexHost 创建或导入。每条用量 MUST 按其原生记录自带的时间戳归入本地日期。子代理的用量 MUST 计入其父会话。

#### Scenario: 未经 CodexHost 的原生会话

- **WHEN** 用户直接在某 Harness 自己的界面或命令行中运行会话
- **THEN** 该会话的用量 MUST 出现在全局统计中

### Requirement: 全局统计必须先给已有结果再后台更新

Host MUST 在启动后于后台预读原生会话。统计请求 MUST 立即返回已有结果；结果过期时 Host MUST 在后台重读，并在首次读取未完成时提供读取进度。Host MUST NOT 为此定时扫描。

#### Scenario: 首次读取尚未完成

- **WHEN** 用户在首次读取完成前打开统计页
- **THEN** 页面 MUST 能获得读取进度
- **AND** 已读部分的结果 MAY 先行显示

### Requirement: 用量读取必须是可选的 Adapter 能力

Harness Adapter 契约 MUST 提供一个可选的只读用量读取能力：列出本机原生会话存储单元及其不读内容即可得到的指纹，并读出单元内统一口径的用量记录（原生时间戳、实际模型 ID、各项 Token、记录 ID）。Adapter MAY 不实现该能力。Host MUST 只从已加载且实现了该能力的插件读取；未实现的 Harness MUST 不出现在统计中且 MUST NOT 影响其他 Harness。官方 Codex MUST 由独立的统计插件提供读取器，按同一记录形式参与汇总，Host MUST NOT 内置 Codex 私有存储解析。插件 MAY 仅提供统计能力而不提供会话操作；此类插件 MUST NOT 进入 Session 创建、检查或委派路由。调用该能力 MUST NOT 触发 Adapter 的原生进程、连接或会话。

#### Scenario: Harness 未实现用量读取能力

- **WHEN** 某个已启用的 Harness 插件没有实现用量读取能力
- **THEN** 全局统计 MUST 不包含该 Harness
- **AND** 其他 Harness 的统计 MUST 照常提供

#### Scenario: Codex 只提供统计插件

- **WHEN** 已启用 `kind: "usage"` 的 `codex-usage` 插件
- **THEN** Host MUST 通过公共加载器和统计能力汇总其用量
- **AND** 插件 MUST NOT 被要求实现 `inspect/open` 或聊天、分叉、恢复操作
- **AND** 未启用时 MUST 不加载其代码且不提供该插件的统计

#### Scenario: 某个读取器失败

- **WHEN** 某个 Harness 的读取器读取原生存储失败
- **THEN** Host MUST 只缺少该 Harness 的这部分结果
- **AND** MUST NOT 使整个统计失败或影响其他 Harness

### Requirement: 原生存储必须增量读取

Host MUST 按存储单元指纹缓存解析结果；指纹未变的单元 MUST NOT 重新解析。对只在末尾追加的单元，读取器 SHOULD 从上次位置继续读取。指纹显示单元被截断或改写时，Host MUST 丢弃该单元的旧结果并重新解析。

#### Scenario: 会话文件追加了新请求

- **WHEN** 某会话文件自上次读取后只在末尾追加了内容
- **THEN** 新追加的请求 MUST 计入统计
- **AND** 已计入的请求 MUST NOT 重复计入

### Requirement: 官方 Codex 用量必须从 rollout 正确还原每次请求

Codex 统计插件读取 rollout 时 MUST 优先使用原生明确请求记录，在旧记录中由累计计数还原每次请求的用量，MUST NOT 把同一请求的记录与累计检查点重复计入。插件 MUST 返回包含缓存的统一输入 Token，由公共计价层扣除已包含的缓存读与缓存写后计价，MUST NOT 在插件和公共层重复扣除。同一 thread 续写到多个文件时 MUST 合并计算；`sessions` 与 `archived_sessions` 中的副本 MUST 只在能证明其为另一份的前缀时视为重复；压缩请求 MUST 只计一次。

#### Scenario: 会话被归档后仍保留副本

- **WHEN** 同一 rollout 同时存在于 `sessions` 与 `archived_sessions`，且一份是另一份的前缀
- **THEN** 该会话的请求 MUST 只计一次，以较长的一份为准

### Requirement: 设置页必须展示全局用量统计

设置中 MUST 提供“用量统计”页面，供本地控制台与 Desktop 设置共用，展示所在 Host 本机的统计。页面 MUST 支持今天、7 天、30 天、90 天与全部时间范围；MUST 显示总览（Token、缓存命中率、费用）、按日趋势（可按 Harness 与模型筛选）、按 Harness 与按模型的分解、最耗会话与最近会话。存在未计价请求时，页面 MUST 标明费用为下限、列出未计价模型，并 MUST 能在当前页面直接为该模型 ID 设置价格。价格操作 MUST 仅在有模型 ID 的模型行提供，以弹窗编辑该模型的价格；页头 MUST NOT 提供价格入口，MUST NOT 提供常驻价格区域或独立导航页。弹窗 MUST 支持添加、编辑和确认移除该模型的自定义价格，保存或移除成功后 MUST 关闭弹窗、自动刷新统计且保留筛选条件。取消或 Esc MUST 不保存；写入期间 MUST 阻止关闭与重复提交，写入失败 MUST 保留草稿。统计轮询 MUST NOT 清除未保存的价格编辑草稿。

#### Scenario: 最近会话按最后活跃时间列出

- **WHEN** 当前筛选范围内有带原生会话 ID 的请求
- **THEN** 页面 MUST 显示最近会话表，按最后活跃时间从新到旧
- **AND** 最耗会话表 MUST 仍按费用与 Token 列出

#### Scenario: 用户补充未计价模型的价格

- **WHEN** 统计中某模型显示为未计价，用户在页面上为该模型 ID 设置价格
- **THEN** 重新读取后该模型 MUST 按新价格计入费用
- **AND** 该模型 MUST 不再列为未计价
