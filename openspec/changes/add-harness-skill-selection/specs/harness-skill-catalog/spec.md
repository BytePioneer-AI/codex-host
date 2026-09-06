## ADDED Requirements

### Requirement: Skill catalog 来自 Harness 原生枚举
支持的 Harness Adapter SHALL 通过其原生枚举接口（Claude Code：`reloadSkills()`；旧版 CLI 无此接口时回退 `supportedCommands()` 与 stream init 消息的 `skills` 名单交集）发现当前 Session 可用的 skill，并投影为与命令 catalog 相同结构（`HarnessCommandCatalog`）的 Skills catalog。Adapter MUST NOT 通过扫描磁盘、读取或解析 SKILL.md 来构造该 catalog。枚举 MUST 在首条 user message 之前即可返回结果（真机 CLI 直到第一条消息入队才向 stream flush init 消息，且任何 control 调用都无法提前触发该 flush）。

#### Scenario: Session 打开后拉取
- **WHEN** Claude Code Session 完成 open 或 resume
- **THEN** Adapter SHALL 拉取原生 skill 枚举并缓存为 Skills catalog

#### Scenario: 枚举接口不可用
- **WHEN** 已安装的 Claude Code 版本不支持 skill 枚举
- **THEN** Skills catalog SHALL 为空
- **AND** Session 打开与后续 Turn MUST NOT 因此失败

#### Scenario: 只有 skill 进入 Skills catalog
- **WHEN** 原生枚举同时返回内置命令与 skill
- **THEN** 仅出现在 Harness 权威 skills 名单（`reloadSkills()`；回退路径为 stream init 消息 `skills` 字段）中的项 SHALL 进入 Skills catalog
- **AND** `/compact`、`/init`、`/recap` 等静态 native 命令 MUST NOT 出现在 Skills catalog

### Requirement: Skill 投影保持现有命令契约
Skills catalog 的每个条目 SHALL 使用 `claude.skill.` 前缀的稳定 ID、以 `/` 开头的 invocation、来自原生 description 的描述，且 `argumentMode` SHALL 由原生 `argumentHint` 是否存在决定（有 → `text`，无 → `none`）。投影 MUST 通过现有 `harnessCommandCatalogSchema` 校验；投影结果 ID 冲突时 MUST 拒绝整批投影并写入诊断，MUST NOT 静默丢弃条目。

#### Scenario: 带参数提示的 skill
- **WHEN** 原生条目包含非空 `argumentHint`
- **THEN** 投影条目的 `argumentMode` SHALL 为 `text`

#### Scenario: 无参数 skill
- **WHEN** 原生条目的 `argumentHint` 为空
- **THEN** 投影条目的 `argumentMode` SHALL 为 `none`
- **AND** 执行时携带参数 SHALL 在命令边界被拒绝

### Requirement: Skill 执行复用命令执行通路
用户执行 Skills catalog 中的条目时，Adapter SHALL 通过该 Harness 的原生 Turn 提交通道以 `/ <name> [arguments]` 形式发起一次真实 Turn，并沿用现有 Item/Turn 投影、审批、取消与历史持久化。Host MUST NOT 为其新增第二条执行 RPC，MUST NOT 提供任意字符串命令透传。

#### Scenario: 显式装载进本轮
- **WHEN** Renderer 以有效 skill command ID 与合法参数调用 `codexhost/thread/command/execute`
- **THEN** Adapter SHALL 提交对应的原生 slash Turn 并开始流式投影
- **AND** 该 Turn SHALL 与普通 Turn 一样可取消、可审批、可持久化

#### Scenario: 未知或已失效的 skill ID
- **WHEN** 执行请求的 command ID 不在当前 Skills catalog
- **THEN** Host SHALL 以结构化错误拒绝
- **AND** MUST NOT 提交任何 Turn

#### Scenario: Session busy
- **WHEN** 执行请求到达时该 Session 正在运行 Turn
- **THEN** 执行 SHALL 按现有 busy 拒绝语义失败

### Requirement: Skills catalog 随原生变化刷新
当 Harness 原生侧推送命令/skill 集合变化（Claude Code：`system/commands_changed`）时，Adapter SHALL 以 REPLACE 语义更新缓存的 Skills catalog，并按现有 catalog 失效通路暴露给 Host 与 Renderer。

#### Scenario: 中途动态发现
- **WHEN** Session 运行中收到 `commands_changed` push
- **THEN** 下一次 `skills/inspect` SHALL 返回替换后的 catalog
- **AND** 已被原生侧移除的 skill MUST NOT 仍可执行

### Requirement: Skills 发现 RPC
Host SHALL 提供 `codexhost/thread/skills/inspect`，参数与 `codexhost/thread/commands/inspect` 相同（threadId），返回该 Thread 当前 Harness 的 Skills catalog 或空 catalog。该 RPC MUST 保持 Harness 中立：未声明 skills capability 的 Harness 返回空 catalog，而非错误。

#### Scenario: 外部 Thread 查询
- **WHEN** Renderer 对 Claude Code Thread 调用 `skills/inspect`
- **THEN** Host SHALL 经 Adapter 返回缓存的 Skills catalog

#### Scenario: 非 Claude Harness 查询
- **WHEN** Renderer 对 Pi/Grok/OMP/DeepSeek/OpenCode/Antigravity Thread 调用 `skills/inspect`
- **THEN** 结果 SHALL 为空 catalog

### Requirement: Skills 按钮与快捷键
Renderer SHALL 在 Composer 的 Harness 控件区提供独立于 Harness Commands 按钮的 Skills 按钮，其 popover 列出当前 Thread Skills catalog（含描述与参数提示）并提供过滤输入框。`Cmd/Ctrl+Shift+S` SHALL 打开该 popover。catalog 为空时按钮与快捷键 SHALL 均不产生可见效果。选中条目 SHALL 经 Host 执行 RPC 触发，而非向 Composer 输入框注入文本。

#### Scenario: catalog 为空
- **WHEN** 当前 Thread 的 Skills catalog 为空
- **THEN** Skills 按钮 SHALL 隐藏
- **AND** 快捷键 SHALL 不打开任何界面

#### Scenario: 过滤大量 skill
- **WHEN** catalog 条目较多且用户输入过滤词
- **THEN** popover SHALL 仅展示名称或描述匹配的条目

#### Scenario: 执行反馈
- **WHEN** 用户选中一个 skill 且执行被接受
- **THEN** popover SHALL 关闭，该条目 SHALL 呈现 executing 状态
- **AND** 其输出作为该 Thread 的普通 Turn 出现在 transcript 中
