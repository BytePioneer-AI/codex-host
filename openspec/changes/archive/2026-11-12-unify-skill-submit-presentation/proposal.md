# Proposal

## Why

用户提交 Skill 后，真实对话被当作临时命令，发送回显与执行状态无法正确收尾。公共层需要把提交确认与原生执行生命周期分开。

## What Changes

- **BREAKING** Adapter 在执行开始时明确表达对话或临时操作；目录分类不决定执行性质。
- 外部 Harness 提交保留独立身份、接受/排队/拒绝回执、执行关联与终态，支持无用户消息的操作；官方 Codex `/compact` 沿用原生接受确认，不新增提交终态关联协议。
- 输入与用户气泡统一显示内联 Skill 图标、名称及普通正文，隐藏内部 carrier；保留各 Harness 原生调用。
- 用真实 Adapter 目录与执行串联 Host/Web 的回归测试，补充无对话扩展、时序、失败、取消及重连场景。

## Decisions

- 生命周期而非 Harness 名称、调用入口或 Skill 名称决定展示；不采用可选目录开关作为唯一依据。
- 提交中与 AI 执行中分别展示，不因任意执行结束而清除其他提交。
- 原生历史仍为对话事实源，临时操作不伪造原生 Turn。
- `/compact` 保留命令执行成功后的即时操作快照与原有手动压缩关联，不等待开始事件才确认；官方 Codex 接受回执可无 Turn ID，不用下一轮结束推测压缩结果。

## Capabilities

### New Capabilities

- `user-submission-lifecycle`: 独立、可关联的提交确认与执行终态。

### Modified Capabilities

- `harness-command-capabilities`: 命令生命周期区分真实对话与临时操作，Skill 使用正常消息展示。

## Impact

shared-contracts、harness-adapter、Host Runtime、相关 Adapter、Web Server 与 Web UI；不修改功能文档、Skill 或能力清单。
