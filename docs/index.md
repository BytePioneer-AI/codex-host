# 文档目录

本页列出 `docs/` 下的当前文档与历史归档；标记为“历史归档”的内容只用于追溯决策，不代表当前实现。

## 项目与语言版本

| 文档 | 作用 |
|---|---|
| [`README.en.md`](README.en.md) | 提供 codexhost 项目介绍、安装方式和功能概览的英文版本。 |
| [`README.ko.md`](README.ko.md) | 提供 codexhost 项目介绍、安装方式和功能概览的韩文版本。 |
| [`领域术语表.md`](领域术语表.md) | 统一 Harness、Model、Provider、Account、Thread 等领域术语及其使用边界。 |

## 开发与架构

| 文档 | 作用 |
|---|---|
| [`harness-command-integration.md`](harness-command-integration.md) | 说明新增 Harness 原生命令时的 Adapter、Host、Renderer 边界和验证要求。 |
| [`harness-executable-discovery.md`](harness-executable-discovery.md) | 说明外部 Harness CLI 的跨平台发现机制、当前接入范围和剩余限制。 |
| [`penguin-harness-adapter.zh-CN.md`](penguin-harness-adapter.zh-CN.md) | 说明 Penguin Harness 适配器的连接方式、能力边界、配置项、Session 归档和固定 Agent 配置。 |
| [`penguin-harness-upstream-pr.md`](penguin-harness-upstream-pr.md) | 面向 CodexHost 官方开发者的 Penguin 适配器 PR 草案、变更范围、限制和验收项。 |
| [`acp-layer-follow-up.md`](acp-layer-follow-up.md) | 记录未来出现第二个生产 ACP Harness 后抽取共享 ACP 层的触发条件和边界。 |
| [`codex-desktop-upgrade-diagnosis-playbook.md`](codex-desktop-upgrade-diagnosis-playbook.md) | 提供 Codex Desktop 更新后 Renderer、Bridge、Agent 和 Model 异常的排查流程。 |

## 安装与远程运行

| 文档 | 作用 |
|---|---|
| [`linux.zh-CN.md`](linux.zh-CN.md) | 说明 x64/ARM64 Linux 上安装、兼容性、进程所有权和诊断方法。 |
| [`linux.md`](linux.md) | 提供 Linux 安装与诊断说明的英文版本。 |
| [`remote-ssh-host.zh-CN.md`](remote-ssh-host.zh-CN.md) | 说明通过 Codex Desktop 原生 SSH 工作流使用远程机器上的 Harness。 |
| [`remote-ssh-host.md`](remote-ssh-host.md) | 提供 SSH 远程 Harness Host 使用说明的英文版本。 |
| [`remote-control-host.zh-CN.md`](remote-control-host.zh-CN.md) | 说明通过 Codex Desktop Remote Control 使用被控 Windows 主机上的 Harness。 |
| [`remote-control-host.md`](remote-control-host.md) | 提供 Remote Control Harness Host 使用说明的英文版本。 |

## 历史归档

### Codex Desktop 兼容性事故

| 文档 | 作用 |
|---|---|
| [`archive/codex-desktop-incidents/26.814-compatibility-debt.md`](archive/codex-desktop-incidents/26.814-compatibility-debt.md) | 归档 Codex Desktop 26.814 更新导致 Renderer Request Bridge 和 Agent/Model 路由异常的事故记录。 |

### DeepSeek Harness 接入

| 文档 | 作用 |
|---|---|
| [`archive/deepseek-integration/deepseek-harness-integration-analysis.md`](archive/deepseek-integration/deepseek-harness-integration-analysis.md) | 归档 DeepSeek Harness 接入前后的接口调研、候选方案和分阶段实施分析。 |

### Grok 接入

| 文档 | 作用 |
|---|---|
| [`archive/grok-integration/grok-cli-adapter-integration.md`](archive/grok-integration/grok-cli-adapter-integration.md) | 归档 Grok CLI 通过 ACP 接入 `HarnessAdapter` 的早期架构与能力分析。 |
| [`archive/grok-integration/grok-build-fork-integration.md`](archive/grok-integration/grok-build-fork-integration.md) | 归档 Grok 原生 Session Fork 协议、边界和实施前验证结论。 |

### Harness 可执行文件发现

| 文档 | 作用 |
|---|---|
| [`archive/harness-discovery-pre-2df7058/README.md`](archive/harness-discovery-pre-2df7058/README.md) | 说明统一 Harness discovery 实施前历史材料的归档原因和使用规则。 |
| [`archive/harness-discovery-pre-2df7058/01-desktop-install-discovery-notes.md`](archive/harness-discovery-pre-2df7058/01-desktop-install-discovery-notes.md) | 归档早期分析中关于 Codex Desktop 与 codexhost 原生安装发现的主题。 |
| [`archive/harness-discovery-pre-2df7058/02-per-adapter-harness-discovery-notes.md`](archive/harness-discovery-pre-2df7058/02-per-adapter-harness-discovery-notes.md) | 归档公共发现包实施前各 Adapter 独立查找 Harness CLI 的代码形态。 |
| [`archive/harness-discovery-pre-2df7058/03-invalidated-conclusions.md`](archive/harness-discovery-pre-2df7058/03-invalidated-conclusions.md) | 汇总早期分析中已失效或需要限定条件的结论及当前事实。 |
