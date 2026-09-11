# 参与 codexhost

欢迎报告实际遇到的问题，也欢迎提交小而完整的修复。较大的新能力建议先讨论方向，避免重复实现或引入不必要的长期维护成本。

## Issue

新建 Issue 时可以选择 Bug、Feature 或 Question 表单，也保留空白 Issue。请选择主要影响领域；无法确定时选 `Other / Unknown`，不要把 Harness、Model、Provider 和 Account 混为一谈。

Bug 尽可能包含：

- codexhost 版本、安装方式，Codex Desktop 完整版本 / build；
- OS / 架构、Harness 名称与原生 CLI 版本，本地 / SSH / Remote Control；
- 预期行为、实际行为、最小复现步骤或偶发问题的观察条件；
- 相关的脱敏错误、日志或截图。

暂时未知、不适用或无法复现的部分可以明确说明。这些是便于沟通的建议，不会由自动化对历史内容机械检查或催补。请不要上传 Token、Cookie、认证文件、完整账号目录或未脱敏的私有项目内容；安全漏洞请避免公开披露尚未修复的攻击细节。

## Pull Request

- 目标分支使用 `main`。标题建议采用 `fix(scope): ...`、`feat(scope): ...`、`docs: ...` 等格式。
- 描述目的、关联 Issue（没有可写 `N/A`）、实现范围和实际执行的验证。不要仅写“测试通过”。
- 遵循 [AGENTS.md](AGENTS.md) 和[领域术语表](docs/领域术语表.md)：保留 Harness 原生语义，遵守 Rust / TypeScript 所有权和包边界。
- 根据风险选择定向测试。行为变更应有相关验证，低风险文档、注释修改不要求机械地新增测试。
- 涉及 Desktop、Renderer 或真实 Harness 的变化，分别记录自动测试和实机结果，并说明版本、平台和未验证部分。UI 变化尽可能提供脱敏截图。
- 作者负责理解改动、回应反馈、补充验证和维护自己的分支。维护者不默认接管整个修复工作。

## 自动提示与人工决策

`Repository maintenance` 只做两件事：

- PR 标题明确为 `fix:` / `feat:` / `docs:` 时添加 `bug` / `enhancement` / `documentation`，不明确就跳过，不覆盖人工选择。
- 当前提交的 CI 完成后更新一条简短结果评论；失败时附可识别、脱敏的原始错误日志。排队或运行中不新发评论，等待批准、取消、跳过不能视为全部通过。

不处理 Issue，不催补模板或要求手填验证 SHA，不重复汇总 AI 审查，不自动关闭、批准、合并或切换 Draft。`automation:ignore` 可停用单个 PR 的自动处理。

原有 CI 与发布前校验保持不变。更多细节见[仓库维护自动化](docs/repository-maintenance.md)。
