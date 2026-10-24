# 原生 Codex CLI 选择 / Native Codex CLI selection

codexhost 分别识别 Codex Desktop 安装和选择原生 Codex CLI。Desktop 的包身份、版本、启动器和 Renderer 资源仍由平台探测校验；原生 CLI 可以位于 Desktop 安装之外。外部 Harness 继续使用各自的 Adapter 和原生 CLI，这个选择只决定原生 Codex 请求及 CLI 命令的转发目标。

codexhost discovers the Codex Desktop installation and selects the native Codex CLI separately. Platform discovery still validates Desktop identity, version, launcher, and Renderer resources; the native CLI can reside outside that installation. External Harnesses continue to use their own Adapters and native CLIs. This selection determines the forwarding target for native Codex requests and CLI commands.

## 配置与优先级 / Configuration and precedence

```bash
codexhost launch --codex-cli /absolute/path/to/codex
codexhost inspect --codex-cli /absolute/path/to/codex
codexhost inspect --json --codex-cli /absolute/path/to/codex
```

也可以通过 `CODEX_CLI_PATH` 配置，适用于无参数的 `codexhost` 启动。Launcher 在将 Desktop 的 `CODEX_CLI_PATH` 替换为 Shim 之前读取该值。这里读取的是 Launcher 自身的启动环境；其他 `.desktop` 文件或包装脚本中的配置不会自动导入。

Alternatively, set `CODEX_CLI_PATH`, including for argumentless `codexhost` launches. The Launcher captures this value before replacing Desktop's `CODEX_CLI_PATH` with the Shim. It reads its own launch environment; settings inside another `.desktop` file or wrapper script are not imported automatically.

| 优先级 / Priority | 来源 / Source | `inspect` 来源值 / Source value |
| --- | --- | --- |
| 1 | `--codex-cli` | `command-line` |
| 2 | 非空的继承 `CODEX_CLI_PATH` / Nonempty inherited `CODEX_CLI_PATH` | `environment` |
| 3 | Linux/macOS 和 Windows 解包安装的包内 CLI / Packaged CLI on Linux/macOS and portable Windows | `packaged` |
| 3 | Windows AppX 的 Desktop 管理缓存 / Desktop-managed cache for Windows AppX | `desktop-managed-cache` |

显式选择必须是现存的绝对文件路径；Unix 上必须有执行权限。符号链接会解析为实际文件。选择不得指向当前安装的 Shim，包括符号链接别名和 Unix 硬链接。空白环境值表示未指定。无效的显式选择会报错，不会回退、搜索 `PATH`、下载或安装 CLI。

An override must name an existing absolute file path, with executable permission on Unix. Symlinks resolve to their target files. The selection must not point to the current installation's Shim, including symlink aliases and Unix hard links. A blank environment value means no override. Invalid overrides produce an error instead of falling back, searching `PATH`, downloading, or installing a CLI.

从受管终端再次调用 Launcher 时，如果继承的 `CODEX_CLI_PATH` 解析为当前安装的 Shim，就使用继承的 `CODEXHOST_STOCK_CODEX_PATH` 恢复原生目标并校验，来源记为 `environment`。该恢复不覆盖显式 `--codex-cli`，也不会在普通 CLI 环境中采用无关的私有变量。

When invoking the Launcher again from a managed terminal, an inherited `CODEX_CLI_PATH` that resolves to this installation's Shim uses the inherited `CODEXHOST_STOCK_CODEX_PATH` to recover and validate the native target, with source `environment`. This recovery does not override an explicit `--codex-cli` or adopt unrelated private variables in a normal CLI environment.

显式 CLI 不要求包内 CLI 或 Windows Desktop 缓存存在。未指定时保留各平台原有的默认查找和校验。路径校验不等于版本或协议兼容性测试；用户选择的 CLI 仍需兼容当前 Desktop 的 app-server 协议。

An explicit CLI does not require a packaged CLI or Windows Desktop cache to exist. Without an override, each platform retains its existing default lookup and validation. Path validation is not a version or protocol compatibility test; the selected CLI must still support the current Desktop's app-server protocol.

## 启动与诊断 / Launch and diagnostics

受管启动继续设置 `CODEX_CLI_PATH=<Shim>` 和 `CODEXHOST_STOCK_CODEX_PATH=<选中的原生 CLI>`。Shim 和 Host 通过后者转发原生请求；没有修改 Harness Adapter、Model、Provider 或账号路由。此选择只适用于本地 Desktop，不配置远程 SSH Host。

Managed launch continues to set `CODEX_CLI_PATH=<Shim>` and `CODEXHOST_STOCK_CODEX_PATH=<selected native CLI>`. The Shim and Host use the latter to forward native requests. Harness Adapters, Model, Provider, and account routing are unaffected. The selection applies to the local Desktop and does not configure remote SSH Hosts.

`inspect` 文本输出包含 `packaged_codex_cli`、`executable_codex_cli` 和 `codex_cli_source`。JSON 的 `desktop` 对象对应增加 `packagedCodexCli`、`executableCodexCli` 和 `codexCliSource`；这是 schema v1 的附加字段，旧 Launcher 不提供这些字段。包内路径是资源位置，显式选择时该文件可能不存在。`inspect` 描述本次调用的选择；对已经运行的受管 Desktop 再次启动只会沿用既有实例，不会热切换它的 CLI。

Text `inspect` output includes `packaged_codex_cli`, `executable_codex_cli`, and `codex_cli_source`. The JSON `desktop` object adds `packagedCodexCli`, `executableCodexCli`, and `codexCliSource` as additive schema v1 fields; older launchers omit them. The packaged path identifies the resource location and may not exist when an override is selected. `inspect` describes the selection for that invocation. Launching again while a managed Desktop is running reuses that instance and does not switch its CLI live.

该配置没有改变现有辅助工具在丢失私有环境变量时的恢复规则，也没有扩大受支持的 Desktop 安装格式或增加 AppImage 支持。

This configuration does not change existing helper recovery when private environment variables are lost, expand supported Desktop installation formats, or add AppImage support.
