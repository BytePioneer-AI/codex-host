---
title: 账号与用量
description: 查看各 Agent 的套餐余量、导入凭证到 Pi，以及统计 Token 消耗。
---

# 账号与用量

CodexHost 只读取你在各个 Agent CLI 中已经登录的本地凭证，不存储中央密码库，也不修改官方 Codex 的登录流程。

## 额度隔离

在原版 Codex Desktop 中，ChatGPT / Codex 的 5 小时或 7 天额度耗尽后会锁定输入框。

在 CodexHost 中，只有官方 Codex 会话受 Codex 额度限制。当 Codex 额度用完时，直接在输入框右下角切换到 Claude Code、Pi、OpenCode、Grok、DSH 等外部 Agent 即可继续发送消息，各工具使用各自的本地账号或 API Key。

## 额度总览

打开 **「codexhost 设置 → 账号」** 可查看本机已登录工具的实时余量：

- **支持工具**：Codex（5 小时 / 7 天窗口与重置卡到期时间）、Claude Code、Grok、Cursor、Kimi Code、Qoder、Antigravity，以及配置了余额端点的 Pi（如 DeepSeek）。
- **显示切换**：可切换显示 **剩余** 或 **已用** 百分比，并展示下次重置倒计时。
- **邮箱打码**：点击右上角工具栏的眼睛图标，页面上所有邮箱地址会自动打码为 `al****ce@example.com`，方便截图。

## 将 Codex / Grok 账号导入 Pi

如果本机已通过 OAuth 登录了官方 Codex 或 Grok，可以一键将凭证同步给 Pi 使用：

1. 打开 **「codexhost 设置 → 账号」**。
2. 在 Codex 或 Grok 账号下方点击 **「导入到 Pi」**。
3. 确认入口名称并保存。

无需重启，新建 Pi 会话即可直接选用对应模型。后续可在同一页面更新凭证或移除入口，不影响原有的 Codex 或 Grok 登录状态。

## 用量与费用统计

### 会话实时用量

在支持用量回报的 Agent 会话中，点击底部状态栏的用量按钮可查看当前对话的实时指标：

- **Context**：当前上下文占用与窗口上限。
- **Cache**：缓存读取与写入 Token 比例（缓存命中率）。
- **TTFT 与费用**：首字响应时间与本轮估算费用。

### 全局统计

打开 **「codexhost 设置 → 用量统计」**（或运行 `codexhost console` 打开控制台的「用量统计」页），CodexHost 会自动扫描并去重汇总本机官方 Codex 与各外部 Agent 的历史会话记录，按模型、Agent 和日期统计 Token 消耗与估算花费。
