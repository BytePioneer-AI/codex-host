# 报告数据与渲染

新批次使用 `report.json` **版本 2**；版本 1 继续支持读取、合并和离线渲染。`../lib/report.mjs` 校验结构，模板与渲染器不推断、不修改建议。离线操作只需 Node.js，无 npm 运行依赖、服务器或 GitHub 凭据；采集与推进处理记录还需已登录的 `gh`，仅使用 GitHub REST GET。

## 增量发布

先用 `scripts/prepare-run.mjs` 得到本批 selection 和 report 骨架，填写真实评估，再运行：

```bash
node <skill绝对路径>/scripts/update-report.mjs <本批report.json绝对路径> <项目目录> --selection <本批selection.json绝对路径>
```

项目目录默认 cwd，可从子目录调用；累计输出固定为 Git 根目录的 `pr-triage/report.json` 和 `pr-triage/index.html`。目录必须被 Git 忽略且报告未被跟踪。输入只含本次选取、分析或跳过的项，不把累计报告当本次输入。

- 发布前重新读取拟记完成的条目，核对身份、类型、来源指纹和 PR BASE/HEAD。来源变化或读取失败则保留建议、将 source 置 null 并记录 errors；其他已核验项正常保存。遗漏选中项明确记为本批未完成。
- 合并主键为大小写不敏感的仓库名加编号。GitHub Issue/PR 共用编号空间；跨仓库同号互不覆盖。新记录替换同身份的旧评估或跳过项，其余保留，不因本批缺席而删卡。
- 新 PR 有 originalTitle/effect；v2 新输入还须有 source/nextActor/replyDraft。旧累计 PR 可缺这些新增字段；渲染器用旧 value 展示作用，选择器将无 source 的旧记录视为尚未建立增量基线。
- `report.json` 是唯一进度源，不建第二份 state 文件。逐项 source 是最近一次成功分析并复核的来源版本，不是“看过编号”。顶层 generatedAt 仅为最新批次时间，不代表所有卡片刷新。
- 准备批次不改变累计报告。未存档的新/变更条目下次仍入队；显式强制复评中断时，尚未覆盖的原有同版本评估仍保留为历史，可再次指定编号重评。较旧的逐项来源快照不能覆盖较新的已核验快照。
- v1 合入已有 v2 报告不降级 schema，不删除 Issue，不伪造旧记录的处理进度。
- 历史 errors 保守去重保留，累计 complete 仅在无缺口时为 true；不能从本次记录缺席推断旧缺口已补齐。确已补齐时核验来源，另行备份并修正累计 errors/complete。逐项重试依据 source，不依据历史错误文本。
- stdout 的 current / cumulative 分别是本次/累计计数：evaluated 为 PR 数，issues 为 Issue 数，processed 为其中带已核验来源的数量，skipped 单列，四档 counts 只统计 PR。另有 output/data/backup。聊天不要把累计数说成本次处理数。

旧文件备份到 `backups/snapshot-*/`；校验、HTML 生成后才发布，`.update-lock` 串行化写入，拒绝符号链接目录/文件。损坏 JSON、仅有 HTML、已有锁均停止，不清空历史；只有 HTML 时先从页面导出恢复 JSON。

发布使用两个独立 rename，不承诺 JSON/HTML 双文件事务。中断时可能 JSON 已新、HTML 仍旧；对照备份核验 JSON，再离线重建 HTML。崩溃遗留锁仅在确认没有更新进程后人工移除，不按超时夺锁。

不带 `--selection` 的旧入口仍可离线更新 v1 或不含完成来源的报告，但不能绕过复核新增处理记录。离线重建 HTML 使用下面的渲染器。

## 单次渲染（恢复或调试，不合并）

```bash
node <skill绝对路径>/scripts/render-report.mjs <report.json绝对路径> <尚不存在的index.html绝对路径>
```

父目录须存在，输出不能覆盖已有文件。校验后将 CSS、浏览器脚本、JSON 内联为独立 HTML，不 fetch 相邻 JSON。成功 stdout 包含 output、complete、evaluated（PR）、issues、skipped、PR 四档 counts。失败非零退出，说明字段路径；修正后选新输出文件。

渲染器不能证明证据真实性、链接可访问性或评价正确性；仍由分析步骤核验。不要复制示例或 fixture 充当真实结果。

## 顶层字段

各版本列出的字段必填，不接受额外字段。空数组写 `[]`；未完成来源写 `null`。

| 字段 | 格式 / 含义 |
| --- | --- |
| schemaVersion | 新批次为数字 2；旧版本 1 可读取 |
| generatedAt | 带时区 ISO 时间，如 `2026-01-02T03:04:05Z`；不是页面打开时间或所有条目的处理时间 |
| repositories | 非空、不重复的 OWNER/REPO 数组，包含本次全部目标仓库 |
| scope | 非空：选取范围、本批上限、待后续处理数等 |
| complete | 本批核心采集/分析/复核完成为 true。有 source:null 时必须 false；仅 CI/冲突未知不影响它。不是“所有 Open 队列均已处理” |
| errors | 具体采集/分析缺口字符串数组；完整报告为空，部分结果至少一项。已知编号写清，未知剩余数量如实说明 |
| prs | PR 建议数组，可为空；局部建议用 source:null，不把未知项自动填 ACCEPT |
| issues | v2 必填的 Issue 分诊数组；v1 无此字段 |
| skipped | 跳过项数组，可为空 |

同一 repository + number 不能重复或同时出现在 prs、issues、skipped 中。仓库名不区分大小写，允许跨仓库同号。

## 每个 PR

| 字段 | 格式 / 含义 |
| --- | --- |
| repository / number | 报告范围内 OWNER/REPO 与正整数编号 |
| title / originalTitle | 简洁中文功能标题与原样 GitHub 标题；单行。旧记录可缺 originalTitle |
| effect | 用户可见作用，1–2 句，可说明限制；单行。旧记录可缺 |
| url | 与身份一致的 `https://github.com/OWNER/REPO/pull/N`，无 query/hash |
| baseSha / headSha | 完整 40 或 64 位十六进制 SHA；缺失只能 DISCUSS、写明缺口、source:null |
| verdict | ACCEPT / SIMPLIFY / DISCUSS / DECLINE，恰好一个 |
| reason / value / action | 非空单行：关键判断理由、增量价值、维护者下一步 |
| scope / cost | 非空：实现克制、维护代价；不是顶层选取范围 |
| stats | `{ files, additions, deletions }` 均非负整数；未知用 null |
| integration | 下方的 CI/冲突辅助快照，必填 |
| evidence | 下方格式的证据数组，最多 5 项；非 DISCUSS 或 source 非 null 时至少一项。缺证据只能作为未完成的 DISCUSS 并具体解释 |
| questions | 非空字符串数组；DISCUSS 至少一项，指明谁需要回答什么；其他档可空 |
| simplifications | 非空字符串数组；SIMPLIFY 至少一项，说明删减/复用/拆分与保留收益；其他档可空 |
| source | v2 新 PR 必填的逐项来源；见下文 |
| nextActor | v2 新 PR 必填：非空，建议下一步责任方；不是修改 assignee |
| replyDraft | v2 新 PR 必填：非空未发布草稿，可多行 |

通用渲染允许 v2 累计报告中的旧 PR 缺新增字段；新批次入口强制要求。

### integration

恰好 `{ ci, conflict, collectedAt, note }`：

- ci：pass / fail（含超时等失败终态）/ pending / cancelled / skipped / none（无检查）/ unknown / mixed。
- conflict：clear / conflicting / unknown。
- collectedAt：带时区 ISO 时间；失败也记录尝试时间。
- note：非空，注明混合状态、未知原因、修复提醒或已知成本；不猜测未知成本。

CI 聚合先失败，再进行中；其他终态全通过为 pass，全取消/跳过分别记录，其余组合 mixed 并解释。无检查不是全绿。所有状态都允许任何 verdict，不按状态降档或等待。

### evidence

每项恰好 `{ label, url, revision, detail }`：label/detail/revision 非空；url 为已核验、无凭据的 http/https 链接或 null。label 标明文件/符号或需求；revision 为具体 SHA 或需求版本/读取时间；detail 说明证据支持哪项判断。文件链接优先绑定 SHA，不能只贴路径。

## 每个 Issue（v2）

所有字段必填，不允许 PR 的 verdict、HEAD 等字段。

| 字段 | 格式 / 含义 |
| --- | --- |
| repository / number | 与 PR 同样的身份规则 |
| title / originalTitle | 非空中文问题标题、原样 GitHub 标题 |
| url | 与身份一致的 `https://github.com/OWNER/REPO/issues/N`，无 query/hash |
| summary | 非空：问题、场景和重要限制 |
| category | bug / feature / question / documentation / unknown；本地建议，不改标签 |
| priority | urgent / normal / unknown；reason 给依据 |
| reason | 非空判断依据，区分报告者描述、已核验事实与推测 |
| action / nextActor | 非空：明确下一步及建议责任方 |
| replyDraft | 非空未发布草稿，可多行 |
| missingInfo | 待补充信息字符串数组，可为空 |
| related | `{ url, reason }` 数组；安全 http/https 链接与非空关系依据，可空，不是重复关单授权 |
| evidence | 与 PR 同格式，最多 5 项；source 非 null 时至少一项 |
| source | 同下方逐项来源，未完成为 null |

## 逐项 source

- `null`：分析未完成或核心采集/复核失败，下次重试；配合 complete:false 和具体 errors。
- 对象：恰好 fingerprint（64 位小写十六进制 SHA-256）与 collectedAt（带时区 ISO 时间）。分析完成时原样复制 selection 的 source，不自行计算或编造；发布入口复核后用真实的新采集时间存档。
- 指纹覆盖内容、状态、标签、普通讨论、review 状态、行级反馈、PR HEAD/BASE 和目标分支。CI 是独立辅助信息，不作为价值评估来源。全局 generatedAt、文件 mtime 不是处理依据。
- 请求作者补信息、维护者做产品取舍可以是完整分诊结果；API/代码采集失败不可以。脚本只核对结构和来源，Agent 仍负责分析完成度和证据真实性。

## skipped

v1 恰好 repository、number、title、url、reason。v2 新批次由 prepare-run 生成，另有 kind（pr / issue）与 source；累计旧跳过项可缺这两字段，旧项默认 pr。

URL 须符合实际类型。reason 写草稿/已关闭/已合并；发布前复核状态。没有 verdict，跳过项不占分析上限。

## 结构示例（虚构，不能用于真实评估）

此示例故意不提供来源快照，展示“有局部建议但尚未记为完成”，不是可直接发布的真实分诊。

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-01-02T03:04:05Z",
  "repositories": ["example/project"],
  "scope": "虚构结构示例，不是真实分诊",
  "complete": false,
  "errors": ["示例来源未核验，不推进处理记录。"],
  "prs": [],
  "issues": [
    {
      "repository": "example/project",
      "number": 1,
      "title": "示例：启动后无响应",
      "originalTitle": "Example: app does not respond",
      "url": "https://github.com/example/project/issues/1",
      "summary": "仅展示问题描述的格式，尚未核验。",
      "category": "bug",
      "priority": "unknown",
      "reason": "示例缺少来源核验，不能确认根因。",
      "action": "先核验报告及相关实现。",
      "nextActor": "维护者",
      "replyDraft": "示例草稿：感谢报告，我们将核验提供的信息。",
      "missingInfo": [],
      "related": [],
      "evidence": [],
      "source": null
    }
  ],
  "skipped": []
}
```

## 展示、安全与验证

- PR 四列、Issue 列表、聊天计数及 JSON 导出使用同一数据源。搜索/排序/CI 开关只改变展示；页面不执行 GitHub 写操作，回复草稿明确标注未发布。
- 标题、草稿、问题和路径使用 textContent。JSON 转义 HTML raw-text 边界，链接限无凭据 http/https。完整原始正文仅留批次材料，不把凭据、完整日志或无关隐私塞进累计报告。
- 模板无默认模拟数据。fixture 仅用于测试；CSS/浏览器脚本分文件维护、渲染时内联，离线打开不依赖 fetch。
- 定向验证从根 package.json 运行 `npm run test:triage`。node:test 覆盖分页、增量、重试/强制、复核、兼容和恢复；浏览器测试使用现有 @playwright/test 与本地 Chromium 检查离线 Issue/PR 看板、搜索、详情、导出、恶意文本和移动布局。不访问真实 GitHub，不自动下载浏览器；不可用时说明阻塞。
