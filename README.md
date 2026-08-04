# Codex Host

在 [Codex Desktop](https://openai.com/codex/) 中运行 [Pi](https://github.com/badlogic/pi-mono) 和 Claude Code。

我们认为 Codex Desktop 提供了目前最好的桌面开发交互体验。

但 Codex 并不是唯一优秀的 Agent Harness：有人更依赖 **Claude Code** 在复杂任务上的规划与落地，有人选择 **Pi** 的极简可控与 token 效率（我非常喜欢 Pi）。想用它们，通常只能换到另一个客户端，会话和文件上下文随之割裂。

**Codex-Host** 使用 Codex Desktop 作为主界面，让你在开始任务时选择真正执行任务的 Agent。Pi 与 Claude Code 使用各自本机已有的模型、认证和配置；选 Codex 时，体验也与官方 App 一致。

## 功能状态

| 能力 | Codex | Pi | Claude Code |
| --- | --- | --- | --- |
| 流式回复 | 原生 | ✅ | ✅ |
| 工具状态 | 原生 | ✅ | ✅ |
| Edit Diff | 原生 | ✅ | ✅ |
| 提问 / 取消 | 原生 | ✅ | ✅ |
| Model / Thinking | 原生 | ✅ | ✅ |
| 权限模式 | 原生 | — | ✅ |
| 会话恢复 | 原生 | ✅ | ✅ |
| Thread 管理 | 原生 | ✅ | 🚧 |
| Fork | 原生 | ✅ | ✅ |
| 上下文压缩 | 原生 | ✅ | ✅ |
| 斜杠命令 | 原生 | 🚧 | 🚧 |
| 修订上一条消息 | 原生 | 🚧 | 🚧 |

## 怎么做的

多数「多 Agent 客户端」通过 [ACP](https://agentclientprotocol.com/) 协议接入不同 Harness。接入快，但工具、审批、权限、Diff、提问等原生能力会先被削平，再在 UI 里补一层近似实现。

codexhost 不走这条路：

- **Desktop 侧**：用 CDP / Electron Inspector 在官方 Codex Desktop 上增强 Agent 选择与会话界面，不重做聊天壳，也不改官方安装包
- **协议侧**：用 CLI Shim 透明接入官方 app-server；Codex 请求原样转发
- **Harness 侧**：按各自原生接口接入——Pi 走官方 RPC，Claude Code 走 Agent SDK / CLI——再投影到 Desktop 已有的流式输出、工具、Diff、审批和提问

目标是保真，不只「能聊」。流式、工具状态、可靠 Patch、原生审批和提问，都尽量来自 Harness 自己，而不是 Host 猜测或伪造。

## npm 安装

```bash
npm install -g @codexhost/cli
codexhost
```

要求 Node.js 22 或更高版本。
