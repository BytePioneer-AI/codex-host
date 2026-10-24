# Claude Code Profiles（自定义变体实例）

本文档说明如何在 `codexhost` 中通过外部配置声明多个独立的 Claude Code 变体实例（Profile）。

## 适用场景

- 需要同时使用多个独立的 Claude Code 环境（如工作与个人账号、不同的 `CLAUDE_CONFIG_DIR`）；
- 通过企业自建网关、代理服务或第三方兼容端点接入 Claude Code，并指定特定的可用模型集合；
- 使用自定义 CLI 启动脚本或包装程序注入特定运行时环境。

## 配置文件

变体实例通过用户配置文件声明，默认路径为：

```text
~/.codexhost/claude-code-profiles.json
```

也可以通过环境变量 `CODEXHOST_CLAUDE_PROFILES_FILE` 指定自定义位置。若配置文件不存在，仅加载默认的 `claude-code` Harness，不产生任何副作用。

## 配置格式

配置文件支持顶层对象（包含 `version` 与 `profiles` 数组）或直接顶层数组：

```json
[
  {
    "id": "claude-work",
    "name": "Claude Code (Work)",
    "description": "Work environment with isolated config directory",
    "command": "~/.local/bin/claude-work",
    "configDir": "~/.claude-work",
    "icon": "~/.codexhost/icons/work.svg",
    "environment": {
      "ANTHROPIC_BASE_URL": "https://gateway.example.com"
    }
  }
]
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 是 | 唯一 Harness 标识符，仅限小写字母、数字与连字符（如 `claude-work`），不能为默认的 `claude-code`。 |
| `name` | `string` | 是 | 在 Desktop Agent 选择器与连接设置中展示的名称。 |
| `description` | `string` | 否 | 简短描述，展示在 Harness 提示中。 |
| `command` | `string` | 否 | 自定义可执行程序或包装脚本的路径，支持 `~` 展开。缺省时使用系统默认的 `claude` 命令。 |
| `configDir` | `string` | 否 | 独立的 Claude Code 配置目录（映射到 `CLAUDE_CONFIG_DIR`），支持 `~` 展开。会话转录本、Pending 会话与配置均存放在此目录下，与默认的 `~/.claude` 严格隔离。 |
| `icon` | `string` | 否 | 图标文件路径（支持 SVG/PNG，支持 `~` 展开）或 Data URL（`data:image/svg+xml;base64,...`）。缺省时复用 Claude Code 默认图标。 |
| `iconStyle` | `object` | 否 | 可选矢量样式定义（`vector` / `background` / `borderRadius`）。 |
| `environment` | `object` | 否 | 注入该实例专用的环境变量（键值对）。 |

## 隔离与生命周期

1. **会话与转录本隔离**：当指定 `configDir` 时，该变体的待处理会话（`pendingSessions`）、历史转录本（`projects/`）与会话导入索引均绑定到该目录。
2. **环境缓存隔离**：插件加载时先提取纯净的宿主用户 Shell 环境，再在实例级叠加 Profile 环境变量与 `CLAUDE_CONFIG_DIR`，防止污染共享 Shell 缓存或跨实例泄漏。
3. **原生 SDK 绑定**：原生 SDK 级会话操作（删除、Fork、会话信息及子代理消息读取）在执行时通过锁机制安全绑定目标实例配置目录并立即恢复，避免多实例并发竞争。
4. **Desktop 一等公民**：变体通过标准插件发现机制注册为独立的 Harness，享有完整的模型选择、Thinking 档位控制、权限模式记忆及会话派生能力。
