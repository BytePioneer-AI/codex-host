# codexhost 发布提交指南

本文收录用户提供的 `docsp/发布提交指南.md`，并按当前工作流补充预览发行及渠道规则。本文作为仓库 Skill 的一部分维护，不依赖原来的本地绝对路径；原 `docsp/` 文件保持不动。

正式发布由 annotated Git Tag 触发 GitHub Actions；静默预览发行从默认分支手动运行工作流。不要在本地执行 `npm publish` 或手动创建 GitHub Release。操作清单和已有标签恢复流程见 [Skill](../SKILL.md)。

## 发布前确认

- 目标版本是新的 SemVer，且从未发布过。
- 当前分支基于最新 `main`。
- 不覆盖、回退或提交无关的工作区改动。
- GitHub Actions 已配置有效的 npm 发布凭据。

版本渠道：

| 版本格式 | npm dist-tag | GitHub Release |
| --- | --- | --- |
| `*-test.*` | `test` | 当前工作流不创建 GitHub Release |
| `*-alpha.*`、`*-beta.*`、`*-rc.*` | `next` | Prerelease |
| 稳定 SemVer，默认发布 | `latest` | 正式 Release、latest |
| 稳定 SemVer，手动发布且 `github_prerelease=true` | `latest` | Prerelease、非 latest |

静默预览发行用于“小修复让用户自行下载，但不推送更新提示”：npm 正常发布到 `latest`，GitHub 标记为 Prerelease。当前更新检查读取 GitHub 正式 latest Release，不读取 npm dist-tag；预览发行仍公开可下载。SemVer 预发布则在 npm 使用 `next`，用户需显式安装 `@codexhost/cli@next`。

## 发布步骤

1. 检查并同步代码：

```powershell
git status --short --branch
git pull --ff-only
```

2. 准备版本：

```powershell
npm run release:prepare -- <version>
```

该命令同步以下四个文件：

```text
package.json
package-lock.json
Cargo.toml
Cargo.lock
```

3. 检查版本文件 diff（默认走远端 CI 门禁时不在本地跑全套 `npm run check`；仅在用户明确选择 `skip_ci=true` 跳过远端 CI 时才在本地执行 `npm run check` 兜底）：

```powershell
git diff
```

若因 `skip_ci=true` 执行本地 `npm run check` 时被已有的、与本次版本无关的问题阻断，必须报告问题，不要顺手修改无关文件。

4. 提交并推送版本变更：

```powershell
git add package.json package-lock.json Cargo.toml Cargo.lock
git commit -m "chore: prepare v<version>"
git push origin main
```

默认在推送 Tag 前，必须确认该版本提交对应的 `CI`（`main` 的 push run）已成功。可以在 CI 运行期间编写 Release Notes 并等待用户确认。Tag 触发的发布工作流也会最多等待 30 分钟；远端 CI 失败或超时仍会阻止默认发布。用户明确选择不等待且不校验 CI 时，使用下述手动发布的 `skip_ci=true`，不能通过普通 Tag push 选择跳过。

5. 编写 Release Notes 到临时文件 `.git/release-notes-v<version>.md`。首行是 Tag 标题 `codexhost v<version>`，空一行后是正文，正文必须非空。按下面的模板和写作规范写：

````markdown
codexhost v<version>

本次更新带来 Composer 命令按钮和 Grok 上下文压缩，并改进了 Windows 和手机端体验。

### ⌨️ Composer 更好用
输入框旁新增 Harness 命令按钮，模型列表支持搜索；设置页可以复制 Agent 连接诊断。
— @maintainer · @contributor-a

### 🗜 Grok 可以压缩上下文
对话过长时可以自动或手动压缩，压缩后继续在同一个 Thread 里对话。
— @contributor-b

## 🚀 新功能
- Composer：新增 Harness 命令按钮 (#123)
- 模型选择器：支持搜索
- 设置：可以复制 Agent 连接诊断

## 🐛 修复
- Usage：对话过程中不再停止更新 (#126, #127)
- Linux：Inspector 无法打开 Codex Desktop
- 另有 12 项稳定性修复
- ⚠️ 已知问题：<一句话>

---

This release brings a Composer commands button and Grok context compaction, with improvements to Windows and mobile.

### ⌨️ Better Composer
A Harness commands button sits next to the input, and the model list is searchable; Settings can copy Agent connection diagnostics.
— @maintainer · @contributor-a

### 🗜 Grok context compaction
Compact long conversations automatically or on demand, then keep going in the same Thread.
— @contributor-b

## 🚀 Features
- Composer: Harness commands button (#123)
- Model picker: search
- Settings: copy Agent connection diagnostics

## 🐛 Fixes
- Usage: stopped updating during a conversation (#126, #127)
- Linux: Inspector could not open Codex Desktop
- 12 more stability fixes
- ⚠️ Known issue: <one sentence>

## Install & Upgrade
- New install: `npm install -g @codexhost/cli`, or download the installer for your platform from Assets below.
- Upgrade: `codexhost update`. For npm installs, run `codexhost stop` before reinstalling.
- macOS "cannot verify this app": `xattr -dr com.apple.quarantine /Applications/codexhost.app`
- More: [README](https://github.com/BytePioneer-AI/codex-host#readme)

## 🙏 致谢 / Thanks
@maintainer · @contributor-a (#123, #124) · @contributor-b (#125)
````

### Release Notes 写作规范

读者主要有两类：在应用内更新页看全文、想知道跟自己有没有关系的现有用户；在 GitHub 下载安装包的新用户。应用内会渲染整篇正文，所以中文在前，安装说明压到最后几行。

- **结构**：一句话总结 → 主题 → 新功能 → 修复 → `---` → 同结构英文 → Install & Upgrade → 致谢。总结和主题前不加栏目标题；新功能、修复带图标（🚀 🐛），条目前不加图标。有破坏性变更时，在总结之后、主题之前单列 `## ⚠️ 破坏性变更`，英文同样处理。
- **应用内更新公告**：总结和主题会作为该版本的应用内更新公告，在用户升级后弹出，规则见 [更新公告](../../../../docs/product/release-announcement.md)。没有主题的 Release 不弹公告。发布后修改 Release 正文，只影响尚未确认的用户和手动查看。
- **一句话总结**：正文第一段，`本次更新带来……，并改进了……。`，点出最重要的两三件事和涉及的方面。
- **主题**：4～7 个，按用户能感知的方面归并（一个主题可以合并多个 PR 和修复），每个主题三行：`### <图标> <短标题>`、一两句说明（写用户现在能做什么、哪些问题不再出现，多件事用分号隔开，不带 PR 编号）、`— @a · @b`（该主题涉及 PR 的作者，维护者直接提交的记维护者）。图标每个主题不同。每位贡献者至少出现在一个主题里。
- **新功能 / 修复**：每条只写一件事，一句话。开头写关键词（Harness 名、平台或功能区，如 `Claude Code：`、`Windows：`），方便用户扫到跟自己相关的条目。新功能写用户能做什么；修复写用户遇到过的现象，不写原因和实现。新功能不超过约 10 条，修复不超过约 16 条，其余合并为最后一条"另有 N 项…修复"。
- **不写内部细节**：不出现内部名词、文件、字段和机制；不列 docs、chore、测试、CI 改动。
- **已知问题**：没有固定栏目。有时在修复列表末尾加一行 `⚠️ 已知问题：…`，没有就不写。
- **术语不翻译**：`codexhost`、`Harness`、`Composer`、`Thread`、`Fork`、`Model`、`Thinking` 等保持英文，嵌在中文句子里。
- **Issue / PR 编号**：条目末尾写 `(#123)`，多个写 `(#123, #124)`。只标能从 Git 历史、GitHub 关联或 PR 内容核实的已合入编号；没有对应 PR 就不写。同一条的中英文使用相同编号。
- **Install & Upgrade**：只写英文，固定 4 行，内容如模板。其余安装问题指向 README，不在 Release Notes 里重复。
- **致谢**：放在最后，标题固定为 `## 🙏 致谢 / Thanks`（GitHub 会在正文下方自动生成头像区 Contributors，标题不能与它重名），一行用 ` · ` 分隔。以从上一个 Release Tag 到目标提交的实际 Git/GitHub 贡献者为准，使用 GitHub 用户名；同一人的多个提交身份合并；维护者也列入。有已合入 PR 时写 `@user (#123, #124)`，没有就只写用户名。测试机器人、合并机器人和纯自动化账号不列入。

6. Release Notes 完成后，必须向用户展示全文并取得明确确认。用户未确认或要求修改时，必须暂停，不得创建或推送 Tag。

7. 用户确认文案，并确认确切提交远端 CI 成功或明确选择手动发布的 `skip_ci=true` 后，选择发布入口。

### 正式发布或 SemVer 预发布

在刚推送的版本提交上创建并推送 annotated Tag：

```powershell
git tag -a v<version> --cleanup=verbatim -F .git/release-notes-v<version>.md
git show --no-patch v<version>
git push origin v<version>
```

`--cleanup=verbatim` 用于保留 Markdown 标题和正文格式。若 HEAD 已发生变化，明确指定刚验证的版本 commit SHA，不把后续提交误打进标签。

### 静默预览发行：npm latest + GitHub Prerelease

使用稳定版本号，从默认分支 `main` 手动运行 `Release packages`，指定：

```text
tag=v<version>
github_prerelease=true
skip_npm=false
```

复用正确的现有 annotated Tag，不覆盖或移动它。新标签正常推送会立即触发默认正式发布，**不能推送后再靠取消规避**。当前安全操作是在用户明确授权、确认没有并行发布后，短暂禁用 Release packages 工作流，推送 annotated Tag，再恢复原状态并手动 dispatch；具体授权、状态恢复与失败处理见 [Skill](../SKILL.md#静默预览发行npm-latest--github-prerelease)。没有授权则停在准备阶段。

该输入只影响新建 GitHub Release 的状态，不改变 npm dist-tag，不修改已有 Release。恢复此类发布时不能直接重跑旧的 tag push run，必须重新手动 dispatch 并保持 `github_prerelease=true`。

### 手动发布的可选 CI 门禁

手动运行 `Release packages` 时，`skip_ci` 默认是 `false`：最多等待 30 分钟并要求确切提交的四项基线 CI job 成功，发布前复验同一 run / attempt。

用户明确授权后可设为 `true`：不等待、不查询或校验 CI；即使没有 CI、CI 未完成或失败，也继续执行其余发布流程。版本、annotated Tag、Release Notes、提交在 `main`、构建及产物校验保持不变。跳过记录写入 `release-evidence.json` 和 Actions Summary，并发出警告，不视为 CI 通过。此设置可与 `github_prerelease` 和 `skip_npm` 组合，恢复或重启发布时需重新传入。

该选项要求从 `main` 手动发布已有的正确 annotated Tag。新 Tag push 自动触发的发布仍要求 CI；若要新 Tag 仅走手动发布，必须先取得用户对临时禁用整个发布工作流的授权，按静默预览发行相同的禁用、推送、恢复、手动运行步骤操作，不先推 Tag 再取消。此选项不免除本地验证、Release Notes 确认或 Tag 操作授权。

## 自动发布结果

Tag 推送后，GitHub Actions 会自动：

- 校验 Tag、npm 版本和 Cargo Workspace 版本一致。
- 构建 Windows x64/arm64 EXE。
- 构建 macOS x64/arm64 DMG。
- 发布 macOS、Windows、Linux 的 x64/arm64 共六个平台 npm 包和 `@codexhost/cli` 元包。
- 根据版本及手动发布输入创建公开 GitHub Release Prerelease 或正式 Release；`test` 渠道不创建 GitHub Release。
- GitHub Release 只上传四个安装包，不上传 npm tarball。

## 失败处理

- 构建或最终发布失败：先查看失败步骤，核实原因与已发布产物，再决定是否重跑失败 jobs；不默认放宽测试超时；跳过 CI 必须由用户明确选择手动发布的 `skip_ci=true`。
- 用户要求暂停时取消当前运行，核实 jobs 已停止及是否部分发布，不默认禁用整个工作流。GitHub Actions 不支持原地暂停后续跑。
- 手动发布的模式输入必须保持一致；原 tag push 的默认正式发布不能作为静默预览发行的恢复入口。
- npm 已接受某个版本后，不得修改内容并重新发布同一版本。
- 不得强制移动、删除或覆盖已推送 Tag；确需处理时先取得用户明确确认。
- 不得提交凭据、构建产物、日志、临时 Release Notes、`image.png`、`nul` 或其他无关文件。
