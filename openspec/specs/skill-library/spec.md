# skill-library Specification

## Purpose
发现本机全局与当前工作区的 Skill，维护可即时查询的索引，并让用户在外部 Harness 会话中以带路径的文本引用主动选用任意 Skill。

## Requirements

### Requirement: Skill 来源限定为全局目录与当前项目
Skill 库 SHALL 只扫描集中维护的全局 Skill 目录，以及当前工作区从 cwd 向上到项目边界（含 `.git` 目录或文件的最近祖先；无则仅 cwd）各级的项目 Skill 目录。目录清单 MUST 与已安装的 Harness 插件无关，MUST NOT 扫描其他项目。每个 Skill 是某目录下包含 `SKILL.md` 的子目录。

#### Scenario: 当前项目与全局
- **WHEN** 会话工作区为 `/repo/app`，`/repo` 含 `.git`
- **THEN** 结果包含全局目录中的 Skill，以及 `/repo/app` 与 `/repo` 下项目 Skill 目录中的 Skill
- **AND** 不包含其他仓库的项目 Skill

#### Scenario: 无工作区
- **WHEN** 查询没有工作区（例如未选目录的草稿）
- **THEN** 结果只包含全局 Skill

#### Scenario: 未安装对应 Harness
- **WHEN** 某全局目录属于一个未安装插件的 Harness
- **THEN** 该目录中的 Skill 仍出现在结果中

### Requirement: 扫描有界、异步且只读元数据
扫描 MUST 全程异步，不阻塞 Host 启动或其他请求。递归深度 SHALL 有上限，找到 `SKILL.md` 后不再深入该目录，跳过隐藏目录与依赖目录；目录符号链接 SHALL 按真实路径跟随并防环。每个文件只读取 frontmatter 所需的有界前缀，只接受普通文件。名称缺失、含空白或 `[`、`]`、换行的条目 SHALL 跳过并记录警告。

#### Scenario: 嵌套 Skill
- **WHEN** 某目录下存在 `group/review/SKILL.md`
- **THEN** 在深度上限内发现 `review`，且不再深入 `review` 目录

#### Scenario: 符号链接循环
- **WHEN** 目录符号链接指向其祖先
- **THEN** 扫描正常结束，不重复列出同一 Skill

#### Scenario: 无效 frontmatter
- **WHEN** 某 `SKILL.md` 缺少名称
- **THEN** 该条目不出现，结果携带一条可读警告，其他 Skill 不受影响

### Requirement: 查询读取内存索引
Host SHALL 在启动后后台建立全局索引，在会话或草稿得到工作区时后台建立该工作区索引。查询 SHALL 立即返回内存快照及其版本；仅当首次扫描尚未完成时最多等待一个短期限，超时返回已完成部分并标明未完成。索引 MUST NOT 持久化；工作区索引数量 SHALL 有上限并淘汰最久未用者。查询 MUST NOT 启动或恢复 Harness。

#### Scenario: 索引已就绪
- **WHEN** 用户打开菜单，该工作区索引已存在
- **THEN** 查询不做文件读取即返回结果

#### Scenario: Host 刚启动
- **WHEN** 全局扫描尚未完成时查询
- **THEN** 查询在短期限内返回，未完成时标明结果不完整，而不是显示为完整空列表

### Requirement: 索引保持新鲜
查询距上次校验超过新鲜期、工作区变化或显式刷新时，Host SHALL 在后台校验：重新列出各 Skill 目录，检查每个子目录的 `SKILL.md`（包括之前不存在的），比较修改时间与大小，只重读变化文件。同一目录的并发校验 SHALL 合并；过期任务的结果 MUST NOT 覆盖较新索引。索引变化后 SHALL 递增版本并发出变化通知。

#### Scenario: 已有目录中新增 SKILL.md
- **WHEN** 已存在的目录 `foo` 中新建 `foo/SKILL.md`
- **THEN** 下一次校验后该 Skill 出现，并发出变化通知

#### Scenario: 新鲜期内反复打开菜单
- **WHEN** 用户在新鲜期内多次打开菜单
- **THEN** 不重复触发校验

#### Scenario: 菜单打开期间变化
- **WHEN** 菜单打开时后台校验发现变化
- **THEN** 菜单按新版本更新，不需要重新打开

### Requirement: 读取失败不清空已知结果
只有确认文件或目录不存在时 SHALL 移除对应 Skill。权限、I/O 错误或超时 SHALL 保留上次成功结果，附带警告，并在后续校验重试；一个目录失败 MUST NOT 影响其他目录的结果。

#### Scenario: 目录暂时不可读
- **WHEN** 某全局目录返回权限错误
- **THEN** 该目录上次成功的 Skill 仍保留，结果携带警告

### Requirement: 去重与同名
同一真实路径的 `SKILL.md` SHALL 只出现一次。不同文件的同名 Skill SHALL 全部保留，并各自标明来源（项目或全局及所在目录）。结果 SHALL 先列项目 Skill、后列全局 Skill。

#### Scenario: 多个目录链接到同一 Skill
- **WHEN** 两个全局目录通过符号链接指向同一个 `SKILL.md`
- **THEN** 结果只有一条

#### Scenario: 项目与全局同名
- **WHEN** 项目与全局各有一个名为 `review` 的不同 Skill
- **THEN** 两条都出现，项目条目在前，来源可区分

### Requirement: 外部 Harness 会话展示 Skill 库
Web 与 Desktop SHALL 在本地外部 Harness 会话（含已选 Harness 的草稿）的 Skill 菜单分组中展示 Skill 库结果，与当前 Harness 无关，按名称和描述本地搜索。官方 Codex Thread、只读子会话与远程来源 MUST NOT 展示 Skill 库。查询失败 SHALL 显示可重试的错误，不影响命令与委派候选。

#### Scenario: 草稿中选择 Skill
- **WHEN** 用户在已选工作区的 Pi 草稿中打开菜单
- **THEN** Skills 分组展示该工作区与全局的 Skill，不创建 Thread 或启动 Harness

#### Scenario: 官方 Codex
- **WHEN** 当前会话是官方 Codex Thread
- **THEN** Skills 分组仍来自 Codex 原生目录，Skill 库不参与

### Requirement: Skill 引用以带路径的文本提交
选中 Skill SHALL 在触发位置插入引用，提交文本为 `[$<name>](<SKILL.md 绝对路径> "Read this skill")`；路径含空白或括号时使用尖括号形式。引用 SHALL 保留在用户放置的位置，一条消息可含多个，按普通消息提交、排队与 Steer。Host MUST NOT 将其视为命令，MUST NOT 读取或注入 Skill 正文。

#### Scenario: 句中引用
- **WHEN** 用户输入"请用"，选中 `eli5`，再输入"解释 TCP"并发送
- **THEN** 外部 Harness 收到 `请用 [$eli5](/Users/me/.agents/skills/eli5/SKILL.md "Read this skill") 解释 TCP`

#### Scenario: 运行中发送
- **WHEN** 会话正在运行，用户发送包含 Skill 引用的消息
- **THEN** 消息按普通消息的排队或 Steer 规则处理，而不是被拒绝为忙碌命令

### Requirement: Skill 引用显示为 chip
输入框与用户消息 SHALL 将标签以 `$` 开头、目标为以 `SKILL.md` 结尾的绝对路径的链接显示为 Skill chip（图标与名称），不显示路径正文。识别 SHALL 仅依据消息文本，复制、刷新与重新加载历史后保持一致。

#### Scenario: 重新加载历史
- **WHEN** 用户刷新页面后查看含 Skill 引用的历史消息
- **THEN** 引用仍显示为 Skill chip

#### Scenario: 复制消息
- **WHEN** 用户复制含 Skill 引用的草稿或消息
- **THEN** 剪贴板内容为完整的链接文本
