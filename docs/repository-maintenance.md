# 仓库维护自动化

这套自动化不调用模型、不要求 Codex / CodeRabbit 订阅或模型 API Key。它借鉴 opencodex 的表单分类、确定性检查和提交绑定思路，按 codexhost 的领域与维护方式独立实现；不引入对方的自动关单或 Draft / Ready 状态机。

## 范围与入口

| 功能 | 行为 |
| --- | --- |
| Issue 表单 | Bug / Feature / Question；保留空白 Issue；未知值可明确说明 |
| 自动类型标签 | Issue 模板 / 结构；PR Conventional Commit 标题，必要时回退到提交说明 |
| 自动领域标签 | Issue 的 `Area` 下拉值映射到 `area:*`；不做模型或自由文本语义分类 |
| 信息提示 | 缺少必要说明时在摘要中建议补充；不关闭、不阻止提交 |
| CI / 审查快照 | 显示当前 HEAD 的官方 CI 运行及已有审查证据；不主动请求 AI 审查 |
| 提交绑定 | 比较作者填写的 `Validated commit`、当前 HEAD 和审查记录的提交；旧记录明确提示需复核 |
| 规范提示 | 扫描 Diff 新增行中的聚焦 / 跳过测试和检查抑制；允许指定 HEAD 的维护者例外 |
| 长期等待 | `awaiting-author` 满 14 天或其他 Open 条目满 30 天无其他活动时显示提醒；永不自动关闭 |
| 发布校验 | 标签 / 版本 / release notes / 确切提交的 CI 证据；构建和发布固定使用不可变 SHA |

入口是 `.github/workflows/repository-maintenance.yml`，规则归属私有 Workspace 包 `@codexhost/repository-automation`。该包以源码 ESM 的公共 `index.mjs` 提供接口，便于可信工作流直接运行，不需要 `npm install` 或构建，也不被打包进 Host 产品。

GitHub App 若自行订阅某类标签或事件，仍可能按自己的配置触发模型任务；本自动化不发布 `@codex` / `@coderabbitai` 命令，不负责或绕过它们的额度。

## 标签规则

类型标签为 `bug`、`enhancement`、`question`、`documentation`、`chore`。

PR 标题：`fix:` → `bug`，`feat:` → `enhancement`，`docs:` → `documentation`，`test:` / `ci:` / `build:` / `refactor:` / `perf:` / `style:` / `chore:` → `chore`；支持 `(scope)` 和 `!`。标题无法识别时，读取提交前缀。维护类提交不会压过唯一的功能 / 修复类型；真正混合 `fix` 与 `feat` 时不猜测。

| Issue Area | 标签 |
| --- | --- |
| Desktop / Renderer | `area:desktop` |
| Harness Adapter | `area:adapter` |
| Thread / History | `area:thread` |
| Accounts / Usage | `area:accounts` |
| Install / Update | `area:install-update` |
| Remote | `area:remote` |
| Documentation | `area:docs` |
| Other / Unknown | 不添加领域标签 |

工作流首次实际运行时会创建缺失的受管标签，不覆盖已有标签的颜色或说明。记录到人工或其他工具添加 / 删除某类标签后，会停止自动同步该类别，避免覆盖非本自动化的选择。Issue 表单默认赋予的类型也视为明确选择。对于其他脚本用 `github-actions[bot]` 写入的同类标签，应避免同时管理这组标签。

## 刷新与预览

文件合入默认分支后，Issue 创建 / 编辑、PR 更新、讨论评论、CI 工作流事件、可信 CodeRabbit commit status 会触发刷新。每六小时扫描全部 Open 条目，补上遗漏的事件以及人工审查提交后的状态变化；人工 review 事件本身不直接运行写权限工作流。

工作流串行写入，避免定时扫描和事件刷新互相创建重复摘要。GitHub 可能替换排队中的运行，定时扫描是最终一致性兜底，不承诺实时更新。

维护者可在 Actions 的 `Repository maintenance` 手动运行：

- `number` 指定一个 Issue / PR；留空扫描所有 Open 条目，列表使用分页，不只读取第一页。
- `dry_run` 默认 `true`，不创建标签或修改评论。指定一个编号时，Actions Summary 展示完整评论草稿；批量预览展示每项标签变更计划。
- 确认预览和目标范围后，选择 `dry_run=false` 才会实际写入。手动执行必须选默认分支。

每个条目只维护一条自有机器人评论；内容不变不重复写入。锁定、关闭或带 `automation:ignore` 的条目跳过。添加该标签不会删除已有评论。

状态以评论中的版本化 JSON 保存，仅认可 `github-actions[bot]` 自有标记，不接受贡献者伪造的状态。写入前重新读取条目，HEAD / 描述 / 状态发生变化时放弃旧快照，等待后续刷新。GitHub API 没有跨接口事务，仍不能把这份快照当成合并锁或分支保护。

## 如何理解 CI 和审查状态

- CI 限定 `.github/workflows/ci.yml`，按当前 HEAD 读取官方运行和 jobs。区分未运行、排队、运行中、`action_required`、失败、取消、跳过与成功。
- 四项基线是 `Check ubuntu-22.04`、`Check macos-14`、`Check windows-latest`、`Check Linux ARM64`。工作流显示 success、但其中某项缺少成功证据时，不能称为完整 CI 通过。
- 普通 PR 摘要也可能展示同一 HEAD 的主仓库 push CI；它不是当前合并结果或 Desktop 实机验证的保证。
- Fork CI 可能停在 `action_required`。维护者应先检查 workflow、依赖和安装脚本，再决定是否批准；本工作流不会自动批准 fork CI。
- 人工审查显示明确批准 / 请求修改及其提交，后续纯评论不覆盖这类记录；没有这类记录时显示最近评论或撤销状态。Codex / CodeRabbit 还可读取明确绑定提交的机器人摘要；不认识的格式、仅有通过状态或不存在记录不推定已审。
- CodeRabbit 限流 / 跳过提示优先于旧的完成标记；作者发布相同文字不会获得机器人身份。
- `Validated commit` 必须是作者实际验证过的完整 SHA。缺失就提示未绑定；与 HEAD 不同就提示过期。不会自动将旧的“测试通过”声明绑定到新代码。

如果 GitHub API 读取失败，评论显示未知 / 覆盖不完整，而不是 green。评论或标签历史无法读取时不写入，避免重复评论或覆盖人工标签。工作流成功只表示维护操作完成，不代表产品检查通过。

## 规范提示和明确例外

只检查修改后 Diff 的新增行；不再次实现 ESLint、TypeScript、Rust Clippy 或测试运行器。扫描 `test.only` / `describe.only`、`skip` / `todo` / `xit` 等测试模式，TypeScript / ESLint 抑制注释，以及 Rust `#[ignore]` / `#[allow(...)]`。

这是有限的行模式检查，不是完整语法分析；显式 fixtures / generated / vendor / dist 目录和非代码文件排除。复杂或多行字符串可能误报，多行构造可能未命中；Diff 被 GitHub 截断或没有 patch 时会提示覆盖不完整。没有新增测试文件本身不会被判错。

有合理原因时，有当前 `write` / `maintain` / `admin` 权限的维护者可以在 PR 评论第一行记录：

```text
/codexhost hygiene-exception <40位当前HEAD SHA> <至少5个字符的明确原因>
```

撤销：

```text
/codexhost hygiene-exception revoke <同一HEAD SHA>
```

读取实时权限，不使用 `author_association`、贡献者自勾选或任意标签替代授权；按最新维护者命令处理。新提交自然使旧例外失效。例外仅作为规范提示的处理记录，不跳过 CI、不修改批准状态；维护者处理自己的 PR 也不构成独立审查。

## 长期等待

提醒更新在同一条摘要里，不周期性创建新评论、不保证触发新的邮件通知。计时使用其他活动及条目更新时间，排除本工作流自己的摘要刷新；其他机器人评论也算活动，可能延后提醒。作者回复或编辑后重新计时。

`awaiting-author` 由维护者设置 / 移除，自动信息检查不擅自决定负责人。普通条目 30 天无其他活动时也只提示维护者确认下一步，不以不活跃推断功能没有价值。

## 发布前校验

保留已有 `v*` 标签推送 / 手动发布入口，不增加自动打标签、自动版本升级或自动合并。

GitHub 的标签推送使用标签提交中的工作流定义：新校验只保护包含这些工作流变更的新标签，以及从默认分支运行的新手动入口，不会追溯改写旧标签里的发布逻辑。这也不是不可绕过的仓库权限控制；本次没有设置分支、标签或发布环境保护。

发布由维护者明确决定版本、标签和提交；验证失败后应先核对原因和证据，再决定是否重试，不自动放宽规则：

1. 准备逻辑取自可信默认分支，标签内的内容只作为数据读取。手动发布必须从默认分支运行。
2. 标签必须是合法非占位 SemVer 的 annotated tag，且注释 body 包含 release notes；标签提交必须已经在 `main` 历史上。
3. 标签版本必须匹配 `package.json`、Cargo workspace 和 `package-lock.json` 根版本。工作区内部包的 `0.0.0` 不会被误当作产品版本。
4. 必须找到主仓库 `main` push、确切 release SHA 的最新官方 CI 执行，且四个基线 jobs 全部 success。PR merge-ref 的成功、其他 workflow 的成功、旧提交的成功、跳过、待批准或 API 不可用均不能替代。
5. 构建、npm 发布和 GitHub Release 步骤 checkout 固定 commit SHA，不再重新解析可移动标签。
6. 发布前使用准备时固定的自动化代码 SHA，再核对远端 tag object SHA、提交仍在 `main` 上、CI run ID / attempt 和当前结果。标签移动、`main` 被改写移除该提交或 CI 被重跑后需停止，核对后重新准备发布。

`release-notes` artifact 同时保存 `release-notes.md` 和 `release-evidence.json`，Actions Summary 链接到验证使用的 CI。正式 / 预发布 / `test` npm dist-tag 和现有安装包发布行为保持不变。

若标签推送时确切提交的 CI 尚未完成，发布会停止在 prepare，不会自动等到未来某次成功后发布。确认 CI 通过后，可由维护者手动重新运行。旧发布如没有仍可读取的确切提交 CI 证据，也不会被自动豁免。

## 安全与验证

- 维护工作流仅从默认分支 checkout；不 checkout / 执行 PR head、不安装 PR 依赖、不运行 PR 指定命令。
- 工作流声明最小权限；维护摘要没有 `contents:write`，不改分支保护、Draft、关闭或合并状态。
- 新增及修改的发布工作流 Actions 固定 commit SHA；凭据不持久化到 checkout。
- 用户正文、Diff 和机器人文本作为数据处理；不直接插入 shell、不执行其中指令，转义重新展示的名称、路径和理由。
- 真实 GitHub 写入行为只能在可信分支部署后验证。本地测试使用纯函数、Git 临时仓库和模拟 GitHub API，不评论真实条目或调用真实 Harness。

定向测试：

```bash
npm run test --workspace=@codexhost/repository-automation
```

这些测试也由根 `npm run test:typescript` 和现有 CI 执行。修改 CI job 名称时，应同时更新该包策略和测试。
