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

3. 检查并验证：

```powershell
git diff
npm run check
```

如果 `npm run check` 被已有的、与本次版本无关的问题阻断，必须报告问题，不要顺手修改无关文件。

4. 提交并推送版本变更：

```powershell
git add package.json package-lock.json Cargo.toml Cargo.lock
git commit -m "chore: prepare v<version>"
git push origin main
```

在推送 Tag 前，必须确认该版本提交对应的 `CI`（`main` 的 push run）已成功。可以在 CI 运行期间编写 Release Notes 并等待用户确认，但不得因本地 `npm run check` 已通过而跳过远端 CI。Tag 触发的发布工作流也会最多等待 30 分钟，以避免 CI 尚在运行时产生错误的失败发布；远端 CI 失败或超时仍会阻止发布。

5. 编写 Release Notes 到临时文件 `.git/release-notes-v<version>.md`。正文必须非空。What's New 先写中英摘要，再按 Features / Fixes 分节；中文完整列表放在英文列表之后，不要逐条中英夹杂。用户可见条目如有明确对应的 Issue 或已合入 PR，在条目末尾添加 `#编号`。Installation 及其后的 Contributors 只写英文。例如：

````markdown
codexhost v<version>

## What's New

Composer adds a Harness commands button and model search. Grok can compact context automatically or on demand. Settings can copy Agent connection diagnostics.
Composer 增加 Harness 命令按钮和模型搜索。Grok 支持自动或手动压缩上下文。设置里可复制 Agent 连接诊断。

### Features
- Add a Harness commands button in the Composer (#123)
- Search models in the picker
- Compact Grok context automatically or on demand (#124)
- Copy Agent connection diagnostics from Settings

### Fixes
- Show account credits next to the + button (#125)
- Keep the model picker stable and the selected model visible
- Keep Usage updating during a conversation (#126, #127)
- Open Codex Desktop from Inspector on Linux

### 新功能
- Composer 增加 Harness 命令按钮 (#123)
- 模型选择器支持搜索
- Grok 支持自动和手动压缩上下文 (#124)
- 设置中可复制 Agent 连接诊断

### 修复
- 额度显示回到 + 按钮旁 (#125)
- 模型选择器更稳定，发送后仍显示当前模型
- 对话过程中 Usage 会持续更新 (#126, #127)
- Linux 上 Inspector 可直接打开 Codex Desktop

## Installation

### npm

```bash
npm install -g @codexhost/cli
codexhost
```

### Installer

Download the installer matching your OS and CPU architecture:

### macOS Gatekeeper

After installing on macOS, if codexhost shows "Apple cannot verify this app" when you open it for the first time, run the following command in Terminal and reopen codexhost:

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

## Contributors

Thanks to everyone who contributed to this release:

- @maintainer
- @contributor-a (#123, #124)
- @contributor-b (#125)
````

### Release Notes 写作规范

- **结构**：摘要 → Features → Fixes → 新功能 → 修复 → Installation → Contributors。有破坏性变更时在 Fixes 之后、Installation 之前单列 `Breaking Changes` / `破坏性变更`。
- **摘要**：What's New 开头先用 1-2 句英文概括本版重点，下一行中文对照。不要用 `English / 中文` 合并标题。
- **分节承担类型**：用 `Features` / `Fixes` 分组，条目不要写 `feat:` / `fix:`。
- **不要逐条双语**：每条只写一种语言。英文读者扫完 Features / Fixes 即可；中文读者看摘要后扫 新功能 / 修复。
- **术语不翻译**：`codexhost`、`npm`、`GitHub Releases`、`Launcher`、`Renderer Usage`、`DSH`、`Harness`、`Grok`、`Composer` 等保持英文原样，嵌进该语言的句子里。
- **用户可见条目**：写用户能感知的结果，不写实现细节或 commit 标题。相关提交合并成一条，不要一提交一条。不要列入 docs、chore、测试或错误分支。
- **Issue / PR 标签**：功能或修复如有明确所属 Issue 或已合入 PR，在对应中英文条目末尾添加 `(#123)`；多个直接关联写成 `(#123, #124)`。只标注能够从 Git 历史、GitHub 关联或 Issue / PR 内容核实的编号，不猜测、不关联仍未合入且不代表当前实现的 PR。同一更新的中英文条目使用相同编号。
- **Installation**：单独成节，只写英文。升级操作说明放这里，不必再配中文对照。
- **Contributors**：放在全文最后，只写英文。以从上一个 Release Tag 到目标提交的实际 Git/GitHub 贡献者为准，使用 GitHub 用户名；同一人的多个提交身份合并，不重复列出。维护者也列入。贡献者有明确已合入 PR 时在用户名后列出本次版本对应编号，例如 `@user (#123, #124)`；没有对应 PR 时只写用户名。测试机器人、合并机器人和纯自动化账号不列入。

6. Release Notes 完成后，必须向用户展示全文并取得明确确认。用户未确认或要求修改时，必须暂停，不得创建或推送 Tag。

7. 用户确认并确认确切提交远端 CI 成功后，选择发布入口。

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

## 自动发布结果

Tag 推送后，GitHub Actions 会自动：

- 校验 Tag、npm 版本和 Cargo Workspace 版本一致。
- 构建 Windows x64/arm64 EXE。
- 构建 macOS x64/arm64 DMG。
- 发布 macOS、Windows、Linux 的 x64/arm64 共六个平台 npm 包和 `@codexhost/cli` 元包。
- 根据版本及手动发布输入创建公开 GitHub Release Prerelease 或正式 Release；`test` 渠道不创建 GitHub Release。
- GitHub Release 只上传四个安装包，不上传 npm tarball。

## 失败处理

- 构建或最终发布失败：先查看失败步骤，核实原因与已发布产物，再决定是否重跑失败 jobs；不默认放宽测试超时或绕过 CI。
- 用户要求暂停时取消当前运行，核实 jobs 已停止及是否部分发布，不默认禁用整个工作流。GitHub Actions 不支持原地暂停后续跑。
- 手动发布的模式输入必须保持一致；原 tag push 的默认正式发布不能作为静默预览发行的恢复入口。
- npm 已接受某个版本后，不得修改内容并重新发布同一版本。
- 不得强制移动、删除或覆盖已推送 Tag；确需处理时先取得用户明确确认。
- 不得提交凭据、构建产物、日志、临时 Release Notes、`image.png`、`nul` 或其他无关文件。
