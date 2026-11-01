---
name: codexhost-release
description: 发布 codexhost 正式版、预览版，编写或确认 Release Notes，检查发布 CI，暂停、恢复或排查发布。支持正常正式发布，以及 npm latest + GitHub Prerelease、不给现有用户更新提示的预览发行。不用于普通代码提交或 Harness CLI 更新。
---

# codexhost 版本发布

目标：通过仓库既有 GitHub Actions 发布，不在本地执行 `npm publish`，不手动创建 GitHub Release，不绕过 CI。

## 必须先读

完整读取 [发布提交指南](references/release-guide.md)。该参考收录用户提供的发布指南，并补充正式与预览发行的区别。

所有命令在仓库根目录执行。开始操作前核对当前的：

- `AGENTS.md`、`package.json` 和 `scripts/release/prepare-version.mjs`
- `.github/workflows/release-packages.yml` 与 `.github/workflows/ci.yml`
- `packages/repository-automation/src/release.mjs`
- `docs/operations/repository-maintenance.md`
- 涉及更新提示时：`packages/update-manager/src/github-release.ts`

源码和工作流是执行行为的依据。发现指南与当前实现不一致时，说明差异；不要假装已有不支持的发布能力。

## 1. 确认版本与渠道

先区分 npm 和 GitHub 两个渠道，不能把“预览版”一概等同于 npm `next`。

| 模式 | 版本例子 | npm dist-tag | GitHub Release | 普通用户更新提示 |
| --- | --- | --- | --- | --- |
| 正式发布 | `0.12.2` | `latest` | 正式、latest | 满足更新条件时提示 |
| 静默预览发行 | `0.12.2` | `latest` | Prerelease、非 latest | 不提示此版本 |
| SemVer 预发布 | `0.12.2-rc.1` | `next` | Prerelease | 不提示此版本 |
| npm 测试发行 | `0.12.2-test.1` | `test` | 当前工作流不创建 Release | 不提示此版本 |

“正常发布”走正式发布。“用户能正常从 npm 下载新版，但不要更新提示”走静默预览发行：稳定 SemVer，手动运行工作流时 `github_prerelease=true`、`skip_npm=false`。

静默预览发行仍是公开发行，不是私有版，也不阻止用户通过 npm 更新。当前更新提示读取 GitHub 正式 latest Release，而不是 npm latest。

用户意图不清楚时，先问清两个渠道的目标。最终执行前明确报告版本、npm dist-tag、GitHub 状态与是否提示更新。

## 2. 检查现场与验证

1. 检查工作区、当前分支、远端与已有标签；快进同步 `main`，不覆盖无关修改。
2. 检查目标版本是否已存在于 npm 或 GitHub，是否有正在运行的发布。已推送标签不等于已发布；取消发布也不保证 npm 从未接受某个平台包。
3. 新版本用 `npm run release:prepare -- <version>` 同步四个版本文件，检查 diff。
4. 执行 `npm run check`。已有无关问题阻断时，报告具体文件、步骤和未执行检查，不顺手修复；不得声称全部通过。
5. 只提交四个版本文件，使用 `chore: prepare v<version>`，推送 `main`。
6. 确认**标签目标 SHA 对应的 `main push` CI**成功，包含四个基线 job。不能用另一提交的 CI、本地检查或 PR CI 代替。

CI 失败时查看失败 step 和原始诊断。不自动重试测试或放宽超时；只有核实为可重试的临时故障并获授权后才重跑失败 jobs。重跑完成前不得报告 CI 通过。

## 3. 文案与人工确认

从上一个实际 Release Tag 到目标提交梳理变化，核实已合入 PR 和真实贡献者。按参考指南编写 `.git/release-notes-v<version>.md`：

- 摘要先英文、后中文；英文 Features / Fixes 后放完整中文列表。
- 写用户可见结果，合并同类变化，不列内部 CI、测试、chore 或 docs 改动。
- Installation 和 Contributors 只用英文；PR 编号及贡献者用户名必须有证据。
- 预览发行的 Installation 增加实际安装渠道说明；静默预览版使用普通 npm 安装命令，`rc` 等使用 `@next`。

**向用户展示全文，并取得明确确认后才能创建或推送 Tag。**文案确认后有实质修改，需要再次确认。模糊回复、仅要求查看文案或准备 Skill，不是发布授权。

## 4. 触发发布

### 正式发布 / SemVer 预发布 / npm 测试发行

远端确切提交 CI 成功、文案确认后，在版本提交上创建 annotated Tag：

```bash
git tag -a v<version> <release-sha> --cleanup=verbatim -F .git/release-notes-v<version>.md
git show --no-patch v<version>
git push origin v<version>
```

Tag 推送触发自动发布，版本决定渠道。

### 静默预览发行：npm latest + GitHub Prerelease

**不要先推送 Tag 再取消默认正式发布**：这是竞态，可能来不及阻止 npm 或 GitHub 发布。

1. 核实默认分支工作流支持 `github_prerelease`。
2. 已存在且核实正确的远端 annotated Tag 可直接复用，不移动标签。
3. 新标签仍会触发默认正式发布，当前工作流没有仅推送预览标签的开关。先明确告知用户并取得**临时禁用整个 Release packages 工作流**的授权，核实没有其他发布需要触发；在 CI 和文案确认后，记录工作流原状态，临时禁用、创建并推送 annotated Tag、恢复工作流，再确认没有默认 tag push 发布 run。发生失败也要恢复原状态并报告。没有该授权就停在准备阶段，不推送新标签。
4. 从 `main` 手动运行 `Release packages`，输入：

```text
tag=v<version>
github_prerelease=true
skip_npm=false
```

手动流程固定标签提交，并保留版本及确切提交 CI 校验。工作流的禁用、启用、dispatch 均可通过 `gh workflow` 或 GitHub Actions REST API 操作，先确认权限和原状态。

若权限不足、无法安全恢复工作流或有并行发布，停下并说明阻碍，不退回有竞态的“推送后取消”方案，也不假定用 Git refs API 创建标签一定不会触发工作流。未来若源码增加安全的 tag push 预览路由，优先使用经过验证的新入口并同步本指南。

## 5. 跟踪、暂停与恢复

- 检查实际 workflow run ID、事件、目标 tag / SHA 和输入，不只看工作流名字。
- 没有 `gh` 时可用 GitHub REST API；凭据只在进程内读取，不打印 Token，不写入日志或文档，不把凭据放到命令行参数中。
- 用户说“暂停”：取消本次发布 run，不默认禁用整个工作流。取消后核实各 job 与已发布包 / Release；GitHub Actions 不支持暂停后原地续跑。
- 恢复静默预览发行时，继续从 `main` 手动 dispatch 并显式传 `github_prerelease=true`。**不要直接重跑原来的 tag push run**，否则仍会按默认正式发行执行。
- 默认只重跑失败 jobs；npm 若已接受某个版本，先核实产物与重跑脚本的幂等性，不修改内容再发布同一版本。
- 不删除、移动或覆盖已推送 Tag；确需处理时必须取得针对该操作的明确确认。

## 6. 完成标准

分别核实并报告：

1. 确切发布 SHA 的 CI 结果。
2. npm 元包及全部目标平台包的版本、目标 dist-tag。
3. GitHub Release 的 prerelease 标记、正式 latest 是否符合预期及四个安装包。
4. 静默预览发行没有成为 GitHub latest；不能只凭 `prerelease` 输入推断成功。
5. 工作区状态、运行链接，以及实际执行 / 阻断 / 跳过的检查。

排队、构建中、等待 CI 都只能称为“已启动”，不能称为“发布完成”。只完成其中一个渠道时明确报告部分发布。
