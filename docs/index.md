# 文档目录

本页按长期功能领域列出 `docs/` 的当前文档与历史归档。标记为“方案”“调研”或“历史归档”的内容不代表当前实现。

## 项目入口

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`project/README.en.md`](project/README.en.md) | 英文项目介绍、安装方式和功能概览；维护英文用户入口时阅读。 |
| [`project/README.ko.md`](project/README.ko.md) | 韩文项目介绍、安装方式和功能概览；维护韩文用户入口时阅读。 |
| [`project/领域术语表.md`](project/领域术语表.md) | Harness、Model、Provider、Account、Thread 等领域术语；命名产品和代码概念前阅读。 |

## Harness 架构与公共能力

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`architecture/harness-plugin-runtime.md`](architecture/harness-plugin-runtime.md) | 当前插件加载、预装发行、运行时契约与安全边界；修改插件系统时首先阅读。 |
| [`architecture/harness-plugin-architecture.md`](architecture/harness-plugin-architecture.md) | 插件化目标架构与未完成迁移方案；规划后续解耦时阅读，接口示例不代表当前 API。 |
| [`architecture/harness-command-integration.md`](architecture/harness-command-integration.md) | Harness 原生命令的 Adapter、Host、Renderer 边界；新增命令能力时阅读。 |
| [`architecture/harness-executable-discovery.md`](architecture/harness-executable-discovery.md) | Harness CLI 的跨平台发现和 DSH 特殊连接范围；修改发现或启动逻辑时阅读。 |
| [`architecture/harness-session-import.md`](architecture/harness-session-import.md) | Pi 与 DSH 本地会话导入契约和恢复边界；扩展导入能力时阅读。 |
| [`architecture/external-thread-steering.md`](architecture/external-thread-steering.md) | 外部 Thread 取消旧 Turn 后启动新 Turn 的“调整方向”语义；修改 steering 时阅读。 |
| [`architecture/app-server-transport.md`](architecture/app-server-transport.md) | 原生大历史响应的 WebSocket 与 JSONL 传输边界；排查任务加载、消息大小和转发性能时阅读。 |
| [`architecture/acp-layer-follow-up.md`](architecture/acp-layer-follow-up.md) | 共享 ACP 层的抽取条件与边界；出现第二个适合共享实现的生产 ACP Harness 时阅读。 |

## Harness 专项

[能力表边界](harnesses/capability-boundaries.md)记录各 Harness 的接入条件、Cursor 的单向委派，以及 Pi 权限模式、Antigravity 审批与压缩等剩余缺口。

### Antigravity

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/antigravity/antigravity-tool-approval.md`](harnesses/antigravity/antigravity-tool-approval.md) | agy 的危险跳过权限、旧模式拒绝和问题桥边界；修改权限或交互时阅读。 |
| [`harnesses/antigravity/antigravity-subagents.md`](harnesses/antigravity/antigravity-subagents.md) | agy 原生 Subagent 生命周期、Transcript 和公共投影；修改 Subagent 支持时阅读。 |
| [`harnesses/antigravity/antigravity-question-interaction-postmortem.md`](harnesses/antigravity/antigravity-question-interaction-postmortem.md) | Ask Question 失败历史、后续 Hook 桥实测和限制；排查 agy 提问交互时阅读。 |

### Claude Code

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/claude-code/claude-code-plan-mode.md`](harnesses/claude-code/claude-code-plan-mode.md) | Claude Code 规划模式、计划退出确认与权限状态边界；修改 Plan Mode 时阅读。 |
| [`harnesses/claude-code/claude-code-edit-recovery.md`](harnesses/claude-code/claude-code-edit-recovery.md) | 最后一条消息编辑后的独立 Session、空历史保留和关闭语义；修改编辑恢复时阅读。 |

### CodeBuddy、WorkBuddy 与 Cursor

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/codebuddy/codebuddy-harness-integration.md`](harnesses/codebuddy/codebuddy-harness-integration.md) | CodeBuddy 原生 ACP 插件、生命周期和能力边界；维护 CodeBuddy Adapter 时阅读。 |
| [`harnesses/workbuddy/workbuddy-harness-integration.md`](harnesses/workbuddy/workbuddy-harness-integration.md) | WorkBuddy AI 内置 CLI 的公开 ACP 集成、认证隔离和 Desktop 私有运行时边界；维护 WorkBuddy Adapter 时阅读。 |
| [`harnesses/cursor/cursor-cli-experimental.md`](harnesses/cursor/cursor-cli-experimental.md) | 实验性 Cursor CLI ACP 插件及能力限制；维护 Cursor Adapter 或发行接入时阅读。 |

### DeepSeek Harness

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/deepseek/dsh-edit-recovery.md`](harnesses/deepseek/dsh-edit-recovery.md) | DSH 原生停止确认、消息修订、Fork 和版本化 checkpoint；修改恢复流程时阅读。 |
| [`harnesses/deepseek/dsh-015rc1-validation.md`](harnesses/deepseek/dsh-015rc1-validation.md) | DSH 支持版本、真实 CLI 生命周期和协议验证证据；变更版本范围或 Gate 时阅读。 |

### Hermes

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/hermes/hermes-capabilities.md`](harnesses/hermes/hermes-capabilities.md) | Hermes gateway 提问、Thinking、精确派生、协作发现及旧 ACP 的原生能力边界；维护 Hermes Adapter 时阅读。 |

### OpenCode 与 Pi

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/opencode/opencode-harness-integration-analysis.md`](harnesses/opencode/opencode-harness-integration-analysis.md) | OpenCode 官方接口证据、接入设计和实现边界；维护 OpenCode Adapter 时阅读。 |
| [`harnesses/opencode/opencode-edit-recovery.md`](harnesses/opencode/opencode-edit-recovery.md) | OpenCode 原生 Fork 编辑恢复和取消终态语义；修改编辑或取消时阅读。 |
| [`harnesses/pi/pi-edit-recovery.md`](harnesses/pi/pi-edit-recovery.md) | Pi 空历史编辑、原生文件发布和生命周期 Gate；修改 Pi 恢复时阅读。 |
| [`harnesses/pi/pi-subagents.md`](harnesses/pi/pi-subagents.md) | Pi 的 pi-subagents 异步状态、同步 workflow 子任务、记录读取与适配边界。 |

### OMP

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/omp/omp-interactions.md`](harnesses/omp/omp-interactions.md) | OMP 原生提问、审批、选项说明和超时语义；维护 OMP 交互时阅读。 |

### Grok

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`harnesses/grok/subagent-status-and-model.md`](harnesses/grok/subagent-status-and-model.md) | Grok Subagent 状态、Model、Transcript 与 Desktop 投影；修改 Grok Subagent 时阅读。 |

## 账号与 Desktop 产品接入

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`product/codex-accounts.md`](product/codex-accounts.md) | 设置页中的原生账号与额度、手动导入 Pi 及导入记录管理；修改账号 UI、查询或凭证导入链路时阅读。 |
| [`product/codex-native-account-switching-design.md`](product/codex-native-account-switching-design.md) | 移除 Codex 多账号切换后的只读边界；修改 Codex 认证或账号路由时阅读。 |
| [`architecture/renderer-settings-styling.md`](architecture/renderer-settings-styling.md) | 设置页 Tailwind CSS 使用边界、构建方式与编写规则；新增或改版设置页界面时阅读。 |
| [`operations/codex-desktop-upgrade-diagnosis-playbook.md`](operations/codex-desktop-upgrade-diagnosis-playbook.md) | Desktop 更新后 Renderer、Bridge、Agent 和 Model 异常的诊断流程；升级兼容性回归时阅读。 |

## 平台、进程与远程运行

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`platforms/linux/linux.zh-CN.md`](platforms/linux/linux.zh-CN.md) | Linux 安装、兼容性、进程所有权和诊断的中文说明；维护 Linux 支持时阅读。 |
| [`platforms/linux/linux.md`](platforms/linux/linux.md) | Linux 安装与诊断的英文说明；修改对应中文说明时同步核对。 |
| [`platforms/remote/remote-ssh-host.zh-CN.md`](platforms/remote/remote-ssh-host.zh-CN.md) | 通过 Desktop 原生 SSH 工作流使用远程 Harness；修改 SSH Host 时阅读。 |
| [`platforms/remote/remote-ssh-host.md`](platforms/remote/remote-ssh-host.md) | Remote SSH Harness Host 的英文说明；修改对应中文说明时同步核对。 |
| [`platforms/remote/remote-control-host.zh-CN.md`](platforms/remote/remote-control-host.zh-CN.md) | 在被控 Windows 主机运行 Harness 的 Remote Control 说明；修改该链路时阅读。 |
| [`platforms/remote/remote-control-host.md`](platforms/remote/remote-control-host.md) | Remote Control Harness Host 的英文说明；修改对应中文说明时同步核对。 |
| [`platforms/macos/macos-native-tools.md`](platforms/macos/macos-native-tools.md) | macOS Browser 与 Computer Use 辅助 app-server 路由；修改原生工具兼容性时阅读。 |
| [`platforms/macos/native-aqua-broker.md`](platforms/macos/native-aqua-broker.md) | 在 macOS Aqua 会话运行远程原生 Harness 插件的 Broker；修改 Broker 时阅读。 |
| [`platforms/macos/macos-process-observation.md`](platforms/macos/macos-process-observation.md) | macOS shim 进程树观察、路径读取优化与安全不变量；修改进程监管时阅读。 |
| [`platforms/windows/windows-tool-compatibility.md`](platforms/windows/windows-tool-compatibility.md) | Windows Browser Use、Computer Use 和辅助进程路由；修改 Windows 原生工具支持时阅读。 |

## 维护

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`operations/repository-maintenance.md`](operations/repository-maintenance.md) | PR 标签、CI 评论和发布前检查自动化；修改仓库自动化时阅读。 |

## 待评估方案与问题调查

这些文档记录尚未实施或未批准的方案，不应作为当前能力说明。

| 文档 | 内容与阅读时机 |
| --- | --- |
| [`proposals/zcode-independent-client-feasibility.md`](proposals/zcode-independent-client-feasibility.md) | 借助 ZCode GUI 构建独立客户端的源码调研、复用边界、Host 解耦与分阶段验收方案。 |
| [`proposals/external-harness-idle-unload-proposal.md`](proposals/external-harness-idle-unload-proposal.md) | 外部 Harness 空闲释放与恢复方案、实现进展及验证边界；评估闲置资源回收时阅读。 |
| [`proposals/Reasoning 实时预览与持久 Transcript 的后续方案.md`](proposals/Reasoning%20实时预览与持久%20Transcript%20的后续方案.md) | Reasoning 实时预览与持久留痕方案；规划 Reasoning 展示时阅读。 |
| [`proposals/外部 Harness 回合文件变更汇总问题与后续方案.md`](proposals/外部%20Harness%20回合文件变更汇总问题与后续方案.md) | Turn 文件变更重复汇总问题、语义分层和候选方案；设计净 diff 时阅读。 |

## 历史归档

历史归档只用于追溯决策，不代表当前实现。

### Codex Desktop 兼容性事故

| 文档 | 内容 |
| --- | --- |
| [`archive/codex-desktop-incidents/26.814-compatibility-debt.md`](archive/codex-desktop-incidents/26.814-compatibility-debt.md) | Desktop 26.814 导致 Renderer Request Bridge 和 Agent/Model 路由异常的事故记录。 |
| [`archive/codex-desktop-incidents/26.908-request-manager-wrapper.md`](archive/codex-desktop-incidents/26.908-request-manager-wrapper.md) | Desktop 26.908 Request Manager Fiber 包装导致连接检查失败的事故记录。 |

### Harness 接入与发现

| 文档 | 内容 |
| --- | --- |
| [`archive/deepseek-integration/deepseek-harness-integration-analysis.md`](archive/deepseek-integration/deepseek-harness-integration-analysis.md) | DeepSeek Harness 接入前后的接口调研和分阶段实施分析。 |
| [`archive/grok-integration/grok-cli-adapter-integration.md`](archive/grok-integration/grok-cli-adapter-integration.md) | Grok CLI 通过 ACP 接入 HarnessAdapter 的早期架构与能力分析。 |
| [`archive/grok-integration/grok-build-fork-integration.md`](archive/grok-integration/grok-build-fork-integration.md) | Grok 原生 Session Fork 协议、边界和实施前验证结论。 |
| [`archive/harness-discovery-pre-2df7058/README.md`](archive/harness-discovery-pre-2df7058/README.md) | 统一 Harness discovery 实施前材料的归档说明和使用规则。 |
| [`archive/harness-discovery-pre-2df7058/01-desktop-install-discovery-notes.md`](archive/harness-discovery-pre-2df7058/01-desktop-install-discovery-notes.md) | 早期 Desktop 与 codexhost 原生安装发现分析。 |
| [`archive/harness-discovery-pre-2df7058/02-per-adapter-harness-discovery-notes.md`](archive/harness-discovery-pre-2df7058/02-per-adapter-harness-discovery-notes.md) | 公共发现包实施前各 Adapter 独立发现 CLI 的代码形态。 |
| [`archive/harness-discovery-pre-2df7058/03-invalidated-conclusions.md`](archive/harness-discovery-pre-2df7058/03-invalidated-conclusions.md) | 已失效或需要限定条件的早期结论与当前事实。 |
