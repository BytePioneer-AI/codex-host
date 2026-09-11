# 仓库维护自动化

PR 维护只做两件事：**明确标题自动标签、CI 结束后更新一条简短评论**。不调用模型，不执行 PR 代码，不重复运行 CI。

## 1. 明确标题自动标签

| 标题 | 标签 |
| --- | --- |
| `fix: 修复会话恢复` | `bug` |
| `feat: 增加某个 Harness` | `enhancement` |
| `docs: 更新安装说明` | `documentation` |
| `调整会话处理` | 跳过，不猜测 |

支持 Conventional Commit 的 `(scope)` 和 `!`。不从正文、提交列表、文件路径或历史讨论推断类型；其他前缀不处理。不处理 Issue，包括历史 Issue。

只同步有标签事件证明属于本机器人的三种类型标签。人工或其他工具改过这类标签后停止自动同步；来源不明的现有标签不覆盖。标题变得无法识别时不再修改标签。不会批量删除仓库原有标签或创建领域标签。

## 2. CI 完成后的简短评论

成功示例：

> ✅ 提交 abc1234 的 CI 全部通过。

失败示例：

> ❌ Windows CI 失败。[查看日志](https://github.com/BytePioneer-AI/codex-host/actions)
>
> ```text
> src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.
> ```
>
> 提交 abc1234。

- 只读取 `.github/workflows/ci.yml` 中与 PR 当前 HEAD 对应的可信运行。等待工作流和所有 jobs 结束；排队、运行中或尚无运行时不新发评论。
- 只有工作流和所有 jobs 成功，且四项基线 job 均有唯一成功证据，才报告全部通过：`Check ubuntu-22.04`、`Check macos-14`、`Check windows-latest`、`Check Linux ARM64`。
- 等待批准、取消、跳过、超时、结果不完整分别说明，不能当作通过。CI API 读取失败不发布猜测结果。
- 每个 PR 只更新一条 `github-actions[bot]` 自有评论，兼容此前摘要标记；不会接管人工伪造的同名标记。结果未变化不重复写入，失败恢复后用成功结果替换。
- 评论显示短提交 SHA 并链接完整 SHA，避免新提交尚在运行时把上一轮结果误当成新结果；不会为了更新结果要求作者手填 SHA。
- 失败任务最多展示四个，每项最多摘录五行、每行最多 500 字符。保留错误原文，不翻译、不推断根因。优先提取 TypeScript、Rust、测试、npm 等可识别诊断；有失败 step 时间时只取该时间段。
- 移除日志时间戳和控制字符，脱敏凭据行、常见 Token、长疑似凭据、URL 和用户目录。脱敏是保守的模式匹配，不能保证发现所有未知秘密；CI 本身也不得输出秘密。
- 日志不可用、超过 8 MiB、下载超时或没有可识别错误时，只展示任务状态和 GitHub 日志链接，不复制完整日志或临时签名下载地址。

不再发布信息完整性、模板催补、审查汇总、规范风险、检查例外或长期等待提醒。不自动关闭、转 Draft、批准或合并。

## 触发与安全

入口：`.github/workflows/repository-maintenance.yml`。逻辑归属 `packages/repository-automation/`，可信工作流直接加载公共 `index.mjs`，无需安装依赖或构建。

- PR 创建、编辑、重开、提交或标签变化时同步；CI `workflow_run: completed` 时按实时 PR HEAD 查找目标。
- 不监听 Issue、讨论评论或 CodeRabbit status，不进行定时巡检。漏掉的事件可手动补跑。
- 手动执行必须选默认分支。`number` 指定 PR；留空处理开放 PR。默认 `dry_run=true`，不写评论或标签；指定编号时 Actions Summary 展示评论草稿。
- 已关闭、锁定或带 `automation:ignore` 的 PR 跳过。
- 使用可信默认分支代码、固定 Action SHA 和最小权限。不会 checkout / 执行 PR head、安装 PR 依赖、执行日志内容或传递凭据到日志下载站点。
- 评论和标签历史读取失败时不写入；写入前重新核对 PR 和 CI run/attempt，过期快照放弃。GitHub API 无跨接口事务，这不是分支保护或合并锁。
- 在 GitHub 中手动暂停的工作流，不会因本地代码修改自动恢复。重新启用和批量实际写入应由维护者明确决定。

## 原有 CI 和发布校验

现有 `ci.yml` 仍负责测试、类型检查和 Lint；这次收缩不改动它，也不配置分支保护。

`release-packages.yml` 的发布校验继续保留，不属于 PR 评论功能：

1. 标签必须是合法 SemVer 的 annotated tag，正文包含 Release Notes；提交在 `main` 历史上。
2. `package.json`、`package-lock.json` 根版本及 Cargo workspace 版本必须与标签一致。
3. 确切发布 SHA 的主仓库 `main push` CI 和四项基线 job 必须成功。
4. 构建和发布固定 commit SHA；发布前再次验证远端 tag object SHA、提交仍在 `main`、CI run ID / attempt 和结果。
5. 校验失败就停止发布，不自动改版本、等待后重试或放宽条件；维护者核实后手动重新准备发布。

标签推送使用标签提交里的工作流定义，新校验不会追溯改写旧标签的发布逻辑。这不是不可绕过的权限控制；未设置分支、标签或发布环境保护。

## 验证

```bash
npm run test --workspace=@codexhost/repository-automation
```

定向测试覆盖标题与标签所有权、CI 完整性、等待/失败/恢复、日志提取与脱敏、分页、只读预览、过期快照和发布校验。真实 Actions 写入测试需部署到可信分支并明确启用后执行。
