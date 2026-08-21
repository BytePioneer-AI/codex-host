# SSH 远程 Harness Host

Codex Desktop 可以通过原生 SSH 工作流打开另一台机器上的项目。两端都安装 codexhost 后，远程工作区就能使用只安装、只登录在开发机上的 Harness，包括 Claude Code。

这条链路保留 Codex Desktop 原生界面和 SSH 传输，不会把 Claude 登录伪装成 OpenAI 兼容 API；Native Session 仍由远程机器上的 Claude Code 自己维护。

## 前置条件

- 客户端已安装 Codex Desktop 和 codexhost。
- macOS 或 Linux SSH 开发机已安装 Codex CLI，以及与客户端相同版本的 codexhost。
- 目标 Harness 已在 SSH 开发机安装并登录。Claude Code 请在开发机完成正常登录，不要把账号文件复制到客户端。
- 启用 codexhost 前，Codex Desktop 原生 SSH 工作区已经可以正常使用。

客户端可以是 Windows。远程 Host 暂不支持 Windows，因为 Codex 当前的远程控制传输使用 Unix socket。

## 在 SSH 开发机安装

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote status
```

如果 `codex` 已经指向 OpenCodex 或其他包装器，请显式传入真正的官方 Codex 可执行文件：

```bash
codexhost remote install \
  --stock-codex /absolute/path/to/official/codex \
  --claude-command /absolute/path/to/claude
```

该命令会：

- 把打包的原生 Shim 安装为 `~/.codexhost/remote/bin/codex`。在托管远程环境中，只有精确匹配默认形式的 `app-server --listen unix://` 会启动脱离会话的 listener；Shim 会先等新的 control socket 可连接，再让 Codex Desktop 的后台 SSH bootstrap 返回；
- 把远程 Mapping Store 数据隔离在 `~/.codexhost/remote/data`；
- 在 `.zshenv`、`.bashrc` 或显式指定的 profile 中加入一段带标记的环境配置；该配置既设置 `CODEX_INSTALL_DIR`，也为原生入口提供官方 Codex、Node、Host Runtime、数据目录和可选 Claude Code 的绝对路径；
- 修改 profile 前写入带时间戳的备份；
- 记录已安装原生入口的摘要，因此旧版本包内 runtime 被清理后，后续卸载仍可校验该入口；
- 保持原有 `codex` 命令和 OpenCodex 配置不变。

如果早期候选版安装的是 Shell wrapper，再次运行 `remote install` 会原地迁移该入口。安装后请重新连接远程工作区。已经运行的远程 app-server 不会被就地替换。

脱离规则有意保持严格：命令必须只包含一个默认 `--listen unix://`，并且不能同时启用 `--stdio`；重复 listener、`app-server proxy`、stdio、显式自定义 socket 路径和普通 Codex 命令仍保持原来的前台生命周期。如果默认 listener 提前退出，或十秒内没有把 socket 准备好，bootstrap 会失败，不会误报成功。

## 从 Codex Desktop 使用

在客户端通过 codexhost 启动 Codex Desktop，打开 SSH 工作区，然后在该远程输入框的 Agent/Model 选择器中选择目标 Harness。模型发现、Thread、Turn、工具、审批和历史都会由 SSH 开发机上的 codexhost 处理。

远程项目中新开的任务仍应保持 draft 状态并允许选择 Agent。当前 Desktop 版本会从活动输入框自身的标记判断身份，因此项目页其他位置的后台/预热会话不会再把新任务误锁成已有 Codex Thread；首个 Turn 提交并完成绑定后，实际 Thread 身份才成为准确信息源。

远程 Claude Code 进程使用开发机上的 cwd 和账号。为了让 Codex Desktop 渲染，提示词、流式输出、工具状态、审批和 Diff 会通过现有 SSH 通道投影；凭据文件不会被转发。

## 诊断与回滚

```bash
codexhost remote status
codexhost remote uninstall
```

`status` 会报告原生入口、启动配置、runtime 或数据目录缺失/被修改；遇到会阻塞 bootstrap 的旧 Shell 入口时，也会明确提示重新安装迁移。`uninstall` 会先核对 manifest 中记录的入口摘要，再只移除托管入口、manifest 和启动配置块，并保留 profile 备份及 `~/.codexhost/remote/data`，便于恢复 Thread 映射。卸载后同样需要重新连接远程工作区。

远程 Host 不拥有本机 codexhost Launcher 或自动更新控制器。请在两台机器上使用相同的包管理器更新到同一 codexhost 版本，然后重新连接。
