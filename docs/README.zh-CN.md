<div align="right">
  简体中文 | <a href="../README.md">English</a>
</div>

> [!NOTE]
> 本页为中文版。仓库主 README 为英文：[English](../README.md)。

<div align="center">

# CodexHost

**在 Codex Desktop 中运行 Pi 和其他 Harness**

我们认为 **Codex Desktop** 提供了目前最好的桌面开发交互体验。

但 **Codex** 并不是唯一优秀的 **Agent Harness**，也有人偏好 **Claude Code** 和 **Pi Agent**。

**CodexHost** 让你在 **Codex Desktop** 中选择真正执行任务的 **Agent**，同时保留 **Codex** 的原生体验。

⭐ 如果这个项目对你有帮助，请给我们一个 Star！⭐

<p>
  <a href="https://opensource.org/licenses/MIT"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
</p>

</div>

## 界面预览

Pi、Claude Code、DeepSeek Harness 和 Grok 在同一个 Codex Desktop 中作为独立会话运行。各 Harness 支持的流式输出、思考过程、工具状态、Diff、审批与提问会实时渲染。

![Pi 与 Claude Code 在 Codex Desktop 中运行的完整演示](imgs/demo.gif)

### 界面

![Pi、Claude Code 和 DeepSeek Harness 作为独立 Thread 运行在 Codex Desktop 中](imgs/app-overview.png)

## 功能状态

| 能力 | Codex | Pi | Claude Code | Grok Build | DeepSeek Harness |
| --- | --- | --- | --- | --- | --- |
| 流式回复 | 原生 | ✅ | ✅ | ✅ | ✅ |
| Thinking | 原生 | ✅ | ✅ | ✅ | — |
| 工具状态 | 原生 | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | 原生 | ✅ | ✅ | — | ✅ |
| 提问 / 取消 | 原生 | ✅ | ✅ | 🚧 | ✅ |
| Model / Thinking 选择 | 原生 | ✅ | ✅ | ✅ | 🚧 |
| 工具审批 | 原生 | ✅ | ✅ | ✅ | ✅ |
| 权限模式 | 原生 | — | ✅ | — | — |
| Usage | 原生 | ✅ | ✅ | ✅ | ✅ |
| 会话恢复 | 原生 | ✅ | ✅ | ✅ | ✅ |
| Thread 管理 | 原生 | ✅ | 🚧 | 🚧 | 🚧 |
| Fork | 原生 | ✅ | ✅ | — | — |
| 上下文压缩 | 原生 | ✅ | ✅ | — | ✅ |
| 斜杠命令 | 原生 | 🚧 | 🚧 | — | — |
| 修订上一条消息 | 原生 | ✅ | 🚧 | — | — |

`✅` 已支持，`🚧` 部分支持或开发中，`—` 当前不支持。

## 快速使用

**方式一：使用 npm**

```bash
npm install -g @codexhost/cli
codexhost
```

npm 支持 macOS、Windows 和 [x64 Linux](linux.zh-CN.md)。

**方式二：下载安装包**

从 [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases) 下载最新版安装包，并选择与你的操作系统和 CPU 架构对应的文件。目前安装包支持 macOS 和 Windows。

macOS 安装后，如果首次打开时提示 Apple 无法验证该应用，请在终端执行：
```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```
然后重新打开 `codexhost`。

<details>
<summary><h3>怎么做的</h3></summary>

多数「多 Agent 客户端」通过 [ACP](https://agentclientprotocol.com/) 协议接入不同 Harness。接入快，但工具、审批、权限、Diff、提问等原生能力会先被削平，再在 UI 里补一层近似实现。

CodexHost 尽量不走这条路：

- **Desktop 侧**：用 CDP / Electron Inspector 在官方 Codex Desktop 上增强 Agent 选择与会话界面，不重做聊天壳，也不改官方安装包
- **协议侧**：用 CLI Shim 透明接入官方 app-server；Codex 请求原样转发
- **Harness 侧**：按各自原生接口接入——Pi 走官方 RPC，Claude Code 走 Agent SDK / CLI——再投影到 Desktop 已有的流式输出、工具、Diff、审批和提问

目标是保真，不只「能聊」。流式、工具状态、可靠 Patch、原生审批和提问，都尽量来自 Harness 自己，而不是 Host 猜测或伪造。

</details>

### 交互展示

<table>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent 与 Model 选择</strong></p>
      <img src="imgs/grok-agent-selector.png" alt="提交前选择真正执行任务的 Agent 与 Model，Grok 已加入列表">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage 与费用信息</strong></p>
      <img src="imgs/usage-panel.png" alt="Usage 面板展示上下文、缓存命中与费用估算">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid 图表可视化渲染</strong></p>
      <img src="imgs/codex-vs-pi-agent-tui.png" alt="Pi + Codex Desktop 与 Pi Agent TUI 的 Mermaid 图表可视化渲染对比">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Grok 效果展示</strong></p>
      <img src="imgs/grok-account-credits.png" alt="Grok 效果展示：账户额度与每周用量、重置时间一目了然">
    </td>
  </tr>
</table>

## 鸣谢

- 感谢 [LINUX DO](https://linux.do/) 社区一直以来的支持。
- 感谢 [Paseo](https://github.com/getpaseo/paseo) 项目在多 Harness 接入思路与架构设计方面带来的启发与参考。
