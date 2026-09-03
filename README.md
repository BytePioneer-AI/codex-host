<div align="center">

# CodexHost

**在 Codex Desktop 中运行 Pi 和其他 Harness**

我们认为 **Codex Desktop** 提供了目前最好的桌面开发交互体验。

但 **Codex** 并不是唯一优秀的 **Agent Harness**，也有人偏好 **Claude Code** 和 **Pi Agent**。

**CodexHost** 让你在 **Codex Desktop** 中选择真正执行任务的 **Agent**，同时保留 **Codex** 的原生体验，并让它们协作完成任务

⭐ 如果这个项目对你有帮助，请给我们一个 Star！⭐

<p>
  <a href="https://opensource.org/licenses/MIT"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="docs/imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="docs/imgs/badge-opencode.svg" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="docs/imgs/badge-omp-v5.svg" /></a>
  <a href="https://github.com/QwenLM/qwen-code"><img alt="Qwen Code" src="https://img.shields.io/badge/Qwen_Code-6950EF?logo=qwen&logoColor=white" /></a>
  <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="docs/imgs/badge-agy.svg" /></a>
</p>

<p align="center">
  <sub>简体中文 · <a href="docs/README.en.md">English</a> · <a href="docs/README.ko.md">한국어</a></sub>
</p>
</div>

<p align="center">
  <strong>快速导航：</strong>
  <a href="#界面预览">界面预览</a> •
  <a href="#快速使用">快速使用</a> •
  <a href="#功能状态">功能状态</a> •
  <a href="#跨-agent-协作">跨 Agent 协作</a> •
  <a href="#远程连接-harness">远程连接</a> •
  <a href="#加入交流群">加入交流群</a> •
  <a href="#开发">开发</a>
</p>


## 界面预览

无需切换应用，**Pi、Claude Code、OpenCode、OMP、Grok Build 和 DeepSeek Harness** 都可以在同一个 Codex Desktop 窗口中直接使用。

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### 界面

<div align="center">
  <img width="90%" src="docs/imgs/codexhost-interface-overview.png" alt="Pi、Claude Code、OpenCode、Oh My Pi、Grok Build 和 DeepSeek Harness 作为独立 Thread 运行在 Codex Desktop 中">
</div>

## 快速使用

**使用 npm**

> 支持 macOS、Windows 和 [x64/ARM64 Linux](docs/linux.zh-CN.md)。

```bash
npm install -g @codexhost/cli
codexhost
```

**或下载** [安装包](https://github.com/BytePioneer-AI/codex-host/releases)（macOS、Windows）

<details>
<summary>安装问题排查</summary>

**macOS** - Apple 验证问题

首次打开时如提示应用无法验证，请执行：

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

**Windows** - 绿色解压版 Codex Desktop

如使用绿色版本，将 `CODEXHOST_INSTALL_ROOT` 设置为 Codex Desktop 的解压目录：

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

然后完全退出 Codex Desktop，重新打开终端并启动 codexhost。

</details>

### 交互展示

<table>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>完整工作界面</strong></p>
      <div align="center">
        <img width="90%" src="docs/imgs/codexhost-full-workspace.png" alt="Codex Desktop 中 codexhost 的完整工作界面，展示项目结构、对话区域和多个 Agent 选择器">
      </div>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent 与 Model 选择</strong></p>
      <img src="docs/imgs/agent-harness-selector.png" alt="提交前选择真正执行任务的 Agent 与 Model，Codex、Pi、Claude Code、OpenCode、DeepSeek Harness、Grok 和 Oh My Pi 均可选择">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage 与费用信息</strong></p>
      <img src="docs/imgs/usage-panel.png" alt="Usage 面板展示上下文、缓存命中与费用估算">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="docs/imgs/grok-usage-limits.png" alt="五小时与七天窗口的剩余额度和重置时间">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid 图表可视化渲染</strong></p>
      <div align="center">
        <img width="90%" src="docs/imgs/codex-vs-pi-agent-tui.png" alt="Pi + Codex Desktop 与 Pi Agent TUI 的 Mermaid 图表可视化渲染对比">
      </div>
    </td>
  </tr>
</table>

## 功能状态

| 能力 | <a href="https://openai.com/codex/"><img alt="Codex" src="docs/imgs/badge-codex.svg" /></a> | <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a> | <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="docs/imgs/badge-omp-v5.svg" /></a> | <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a> | <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="docs/imgs/badge-opencode.svg" /></a> | <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a> | <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a> | <a href="https://github.com/QwenLM/qwen-code"><img alt="Qwen Code" src="https://img.shields.io/badge/Qwen_Code-6950EF?logo=qwen&logoColor=white" /></a> | <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="docs/imgs/badge-agy.svg" /></a> |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 流式回复 | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工具状态 | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| 提问 / 取消 | 原生 | ✅ | — / ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — / ✅ |
| Model / Thinking 选择 | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ / — | ✅ / — |
| 工具审批 | 原生 | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 权限模式 | 原生 | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Agent 间任务协作 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Usage | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fork | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| 上下文压缩 | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| 斜杠命令 | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| 修订上一条消息 | 原生 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |

> **Antigravity 当前状态：**接入仍在完善中，工作目录目前固定为 `~/.gemini/antigravity-cli/scratch`。

## 跨 Agent 协作

你可以让当前 Agent 把独立任务交给另一个 Harness。例如：

> 让 `claude-code` 独立审查这次修改，并指出兼容性风险。
>
> 让 `pi` 调查这个测试为什么偶发失败。
>
> 让 `omp` 实现这个功能，我继续整理文档。
>
> 让 `opencode` 在独立 Thread 中验证这个修复，并运行相关测试。

CodexHost 会为目标 Harness 创建独立的 Native Session。委派会话将出现在 Codex Desktop 的会话列表中，你可以随时打开、查看进度或继续对话。

<details>
<summary><h3 id="远程连接-harness">远程连接 Harness</h3></summary>


在本机的 Codex Desktop 中使用远程节点上的 Harness，在远程机器执行任务，同时继续使用 Codex Desktop 的统一界面。两端需要安装相同版本的 codexhost。

**支持两种连接方式：**

#### 1️⃣ SSH 远程（推荐用于 Mac/Linux 服务器）

通过 SSH 连接并控制其他开发节点上的 Harness，需要 Codex Desktop 原生 SSH 工作区。

| 客户端 ↓ / 远程 Host → | macOS | Linux | Windows |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | ❌ |
| Linux | ✅ | ✅ | ❌ |
| Windows | ✅ | ✅ | ❌ |

在 SSH 远程主机上执行：

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

然后通过本地 codexhost 启动 Codex Desktop，打开 SSH 工作区，在远程输入框的 Agent/Model 选择器中选择目标 Harness。

[查看 SSH 配置、诊断与卸载文档 →](docs/remote-ssh-host.zh-CN.md)

#### 2️⃣ Remote Control 远程（实验 · 推荐用于 Windows）

Windows 作为被控 Host 时，可以保留 Codex Desktop 官方配对、账号认证和 relay，在另一台已配对电脑的 Codex Desktop 中使用 Windows 上的 Harness。需先确保官方 Remote Control 已经可以运行原生 Codex 任务。

这条链路不新增公网服务或 TCP 端口；Harness 凭据仍保留在被控 Windows 上。

[查看 Remote Control 配置、传输边界与诊断文档 →](docs/remote-control-host.zh-CN.md)

</details>

<details>
<summary><h3>怎么做的</h3></summary>

多数「多 Agent 客户端」通过 [ACP](https://agentclientprotocol.com/) 协议接入不同 Harness。接入快，但工具、审批、权限、Diff、提问等原生能力会先被削平。

CodexHost 尽量不走这条路：

- **Desktop 侧**：用 CDP / Electron Inspector 在官方 Codex Desktop 上增强 Agent 选择与会话界面，不重做聊天壳，也不改官方安装包
- **协议侧**：用 CLI Shim 透明接入官方 app-server；Codex 请求原样转发
- **Harness 侧**：按各自原生接口接入。Pi 走官方 RPC，Claude Code 走 Agent SDK / CLI，再投影到 Desktop 已有的流式输出、工具、Diff、审批和提问
- **编排侧**：为被委派的 Harness 创建独立 Native Session 与普通可写 Thread，并单独保存委派关系。创建与结果观察彼此分离，发起方显式选择读取、等待或后台运行

目标是保真，不只「能聊」。流式、工具状态、可靠 Patch、原生审批和提问，都尽量来自 Harness 自己，而不是 Host 猜测或伪造。

</details>

## 加入交流群

<table align="center">
  <tr>
    <td>
      <strong>加入交流群</strong><br />
      <sub>对 CodexHost 用法、功能感兴趣的开发者可以扫码加入微信群交流。</sub>
      <ul>
        <li><sub>安装问题可以加群询问</sub></li>
        <li><sub>功能建议与反馈</sub></li>
        <li><sub>开发问题讨论</sub></li>
        <li><sub>Bug 问题建议提交 <strong>issue</strong></sub></li>
      </ul>
      <sub><strong>欢迎一起贡献~ </strong></sub>
    </td>
    <td align="center">
      <img width="230" alt="7ba6eda891ba4c8d091f2a71a8b8e81d" src="https://github.com/user-attachments/assets/e40b162e-a961-43ac-9728-af59890c4d72" />
    </td>
  </tr>
</table>

## 开发

环境要求：官方 Codex Desktop、Node.js 22.19+ 或 24、Rust。

```bash
git clone https://github.com/BytePioneer-AI/codex-host
cd codex-host
npm ci
npm start
```

## 鸣谢

- 感谢 [LINUX DO](https://linux.do/) 社区一直以来的支持。
- 感谢 [Paseo](https://github.com/getpaseo/paseo) 项目在多 Harness 接入思路与架构设计方面带来的启发与参考。
