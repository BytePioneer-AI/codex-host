---
title: CLI 参考
description: 从终端直接查询 Agent、启动子任务、读取输出并控制会话。
---

# CLI 参考

当本机正在运行 CodexHost（已打开桌面端或运行了 `codexhost web`）时，后台会自动写入 `~/.codexhost/cli-credentials.json`（权限 `0600`）。同一系统用户下的终端或脚本无需注册客户端或配环境变量，直接运行 `codexhost` 即可。

::: info 说明
编排子命令不会自动启动后台 Host；使用前请确认桌面端或 `codexhost web` 正在运行。
:::

## 速查

```bash
codexhost harness list --format text                             # 查看可用的 Agent
codexhost project list --format text                             # 查看本地 Git 仓库
codexhost delegate start --harness pi --task "修复单测"          # 新建会话并派发任务
codexhost thread wait <thread-id> --format text                  # 等待当前轮次完成
codexhost thread read <thread-id> --view messages --format text  # 读取每轮对话内容
codexhost thread send <thread-id> --message "补上边界用例"       # 发送下一轮消息
codexhost thread cancel <thread-id>                              # 取消当前运行轮次
```

## 启动任务（`delegate start`）

在当前仓库或独立 Git Worktree 中启动一个新会话：

```bash
codexhost delegate start \
  --harness claude-code \
  --task-name "审查权限边界" \
  --worktree review/auth \
  --watch true \
  --format text \
  --task "检查 packages/host-runtime 的权限边界，列出潜在问题并给出修改建议。"
```

常用参数：

- `--worktree <branch>`：基于当前仓库在 `.worktrees/` 下新建分支和独立工作区，让 Agent 在其中修改代码。
- `--watch true`：任务完成后自动写入完成事件日志（如果从父 Agent 会话中调用，也会通知父会话）。
- `--task-file -`：从标准输入（管道或 `<<'EOF'`）读取多行提示词，避免 Shell 引号转义问题。

执行后立即返回新会话的 `<thread-id>`，并在桌面端和 Web 端侧边栏显示该会话。

## 等待与读取结果（`thread wait` / `thread read`）

```bash
# 等待当前轮次完成（默认最多等 30 秒；若仍在运行则返回当前状态快照，不会中断任务）
codexhost thread wait <thread-id> --format text

# 读取最新一轮的结果摘要
codexhost thread read <thread-id> --view result --format text

# 按轮次读取“用户输入 + Agent 最终回复”（支持 --from 1 --to 10 分页）
codexhost thread read <thread-id> --view messages --format text
```

## 追问、引导与打断（`thread send` / `thread cancel`）

```bash
# 会话空闲时发送下一轮指令
codexhost thread send <thread-id> --message "顺便补上对应的单元测试"

# 会话正在运行时递话微调方向（不打断当前轮次）
codexhost thread send <thread-id> --steer true --message "先只看 host-runtime 包，其他目录不用动"

# 停掉当前正在跑的轮次，确认停稳后立刻发送新指令
codexhost thread send <thread-id> --interrupt --message "先停一下，改为帮我梳理启动流程"

# 仅停止当前正在跑的轮次（保留会话与历史记录）
codexhost thread cancel <thread-id>
```

## 输出格式（`--format`）

所有编排命令均支持 `--format`：

- `text`：紧凑纯文本，适合终端直接阅读或喂给其他 Agent 阅读。
- `compact`：精简版 JSON（含任务深链），适合 Shell 脚本解析。
- `json`（默认）：完整结构化 JSON。
