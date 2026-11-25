## Why

Claude Code Adapter 以 root 运行时一律不向 SDK 传 `allowDangerouslySkipPermissions`（#422）。Claude Code CLI 的原生规则是：只有“root 且未声明沙箱”（未设置 `IS_SANDBOX=1`，也没有真值 `CLAUDE_CODE_BUBBLEWRAP`）才禁止绕过权限。因此即使 root 用户按原生规则设置了 `IS_SANDBOX=1`，会话中切换到 `bypassPermissions` 仍然必定被 CLI 拒绝，界面只显示笼统的失败，且结果被静默回退到原模式。

## What Changes

- Adapter 按 Claude Code 原生规则判断当前 Session 环境是否可用绕过权限，并只在可用时为 Query 传入 `allowDangerouslySkipPermissions: true`；判断使用实际传给 CLI 的环境，而不是 Host 进程环境。
- 不可用时从 Permission Mode catalog 中移除 `bypassPermissions`；显式创建、或在 Claude Code 已启动后切换到该模式时返回 `unsupported`；恢复已保存为 `bypassPermissions` 的 Thread（包括 Host 在 Claude Code 启动前通过选择恢复模式）时降级为 `default` 并如实上报，避免 CLI 启动即退出或 Thread 无法打开。
- 会话中切换被 CLI 拒绝时，保留可操作的原生原因（未以绕过权限能力启动、被 settings 或组织策略禁用），其他失败保持通用提示。
- Renderer 权限选择器在选择被拒绝后显示可见的失败标记，失败原因继续出现在悬停提示与无障碍标签中。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `claude-code-text-session`: 绕过权限的 SDK 前置条件改为按原生 root/沙箱规则有条件传入；不可用时不暴露、不启动、恢复降级，并细分原生拒绝原因。
- `versioned-renderer-agent-routing`: 已有 Thread 的权限模式选择失败时，选择器必须在保持原模式可用的同时给出可见失败标记。

## Impact

- `packages/adapters/claude-code`：权限模式可用性判断、catalog、Session 创建/恢复/切换、Transport 启动参数与相关测试。
- `packages/renderer-extension`：权限选择器失败标记与测试。
- `packages/host-runtime`：仅测试夹具补充新依赖，行为不变。
- 不改变共享契约、Mapping Store 或其他 Harness；不替用户注入 `IS_SANDBOX`。
