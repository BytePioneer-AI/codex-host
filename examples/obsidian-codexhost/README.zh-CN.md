# Obsidian CodexHost 示例

[English](README.md) | [简体中文](README.zh-CN.md)

面向现有本地 CodexHost runtime 的 Obsidian 桌面端客户端。
它不会启动或安装另一个 Agent Host。

## Host 前置条件

通过修改版 Launcher 启动的本地 CodexHost 默认启用 External UI。
设置 `CODEXHOST_EXTERNAL_UI=0` 可关闭此功能。

对于独立运行的开发版 Host，请显式启用：

```bash
CODEXHOST_EXTERNAL_UI=1 ...
```

Host 会在 `~/.codexhost/runtime.json` 发布私有描述文件，并且只监听
`127.0.0.1`。

## 当前 MVP 功能

使用 **Open CodexHost chat** 命令或机器人功能区图标。右侧视图支持：

- 发现并选择 Codex 和已安装的 Harness
- 通过 `model/list` 发现 Codex 默认模型
- 通过 CodexHost 插件传输模型路由外部 Harness
- 使用 Obsidian Vault 作为 `cwd` 启动 `thread/start`
- 启动 `turn/start`
- 流式显示 `item/agentMessage/delta`
- 显示推理摘要
- 显示命令和工具输出
- 显示外部 Harness 审批对话框
- 显示外部 Harness 提问对话框
- 通过 Stop 按钮调用 `turn/interrupt`
- 选中的 Agent 发生变化时创建一个新 Thread

按 Enter 发送消息，按 Shift+Enter 换行。

## 后续计划

下一阶段计划包括文件差异、更丰富的工具卡片、审批持久化范围、多选题交互优化，以及 Thread 历史记录和恢复体验。

## 构建

```bash
npm install
npm run build
```

将 `manifest.json`、`main.js` 和 `styles.css` 复制到 Obsidian 插件目录中。
