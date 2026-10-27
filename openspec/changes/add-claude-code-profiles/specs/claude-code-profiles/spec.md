# Spec Delta: Claude Code Profiles

## Purpose

定义用户声明的 Claude Code Profile 作为独立 Harness 在 codexhost 中的可观察行为。用户可通过外部配置文件声明基于 Claude Code 引擎的自定义实例（具有独立身份、显示名称、图标、启动命令与配置目录），在 Codex Desktop 中作为独立 Agent 参与会话选择、执行与历史恢复。

## ADDED Requirements

### Requirement: Claude Code profiles are discoverable as independent Harnesses

系统 SHALL 支持从外部配置文件（`~/.codexhost/claude-code-profiles.json` 或 `CODEXHOST_CLAUDE_PROFILES_FILE`）中发现用户声明的 Claude Code 变体实例，并将其作为独立的一等公民 Harness 注册到公共插件目录。每个变体实例 SHALL 拥有由配置指定的 `id`、`name` 及可选图标。

#### Scenario: Valid profile declaration appears in Host catalog

- **WHEN** 配置文件包含合法声明（有效的 kebab-case `id`，非 `"claude-code"`，包含 `name`）
- **THEN** Host SHALL 在插件目录中列出该实例，并在 Desktop Harness 列表中可见
- **AND** 新建 Thread 时可独立选择该实例作为 Thread 的所属 Agent

#### Scenario: Missing or malformed profile file does not break Host startup

- **WHEN** 配置文件不存在或包含无效 JSON
- **THEN** 系统 SHALL 安全忽略错误或记录脱敏诊断
- **AND** 基础 `claude-code` 插件及其他 Harness 插件 SHALL 正常加载不受影响

### Requirement: Profile execution uses isolated configuration and executable

每个 Claude Code 变体实例在执行时 SHALL 严格遵循其配置中声明的执行程序与独立配置目录。原生会话、转录本与本地历史 SHALL 写入对应的 `CLAUDE_CONFIG_DIR`，不得写入或污染默认的 `~/.claude` 目录。

#### Scenario: Profile specifies custom configDirectory

- **WHEN** Profile 声明了 `configDir`（例如 `~/.claude-custom`）
- **THEN** 该实例的待处理会话、转录本与执行环境 SHALL 绑定到该目录
- **AND** 默认的 `~/.claude` 目录中不得产生该实例的会话文件

#### Scenario: Profile specifies custom executable command

- **WHEN** Profile 声明了 `command`（例如外部包装脚本路径）
- **THEN** 实例在检查可用性与启动进程时 SHALL 使用该命令
- **AND** 命令解析失败时报告类型化的 `notInstalled` 或 `unavailable` 错误

### Requirement: Profile model catalog reflects profile environment

Profile 实例的模型目录 SHALL 忠实反映其实际配置环境（包括其配置目录中 `settings.json` 的 `modelPicker` 选项），不得假装支持不可用的模型。

#### Scenario: Custom model picker options are declared

- **WHEN** Profile 配置目录的 `settings.json` 中配置了自定义模型且开启 `replaceBuiltInOptions`
- **THEN** Desktop 针对该实例的模型选择器 SHALL 仅展示配置中声明的可用模型
- **AND** 提交会话时 SHALL 正确路由选定的模型

### Requirement: Zero regression for default claude-code

对 Claude Code 适配器参数化及 Profile 支持的引入 MUST NOT 改变原有 `claude-code` Harness 的任何默认行为。

#### Scenario: Standard claude-code is invoked without profiles

- **WHEN** 未配置任何 Profiles
- **THEN** `claude-code` Harness 的身份标识、默认可执行程序路径、`~/.claude` 配置读取、模型检查与原生执行行为与修改前保持完全一致
