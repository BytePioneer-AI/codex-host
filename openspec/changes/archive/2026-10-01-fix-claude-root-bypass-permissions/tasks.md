## 1. 可用性判断

- [x] 1.1 在 Claude Adapter 内实现与 Claude Code 原生规则一致的绕过权限可用性判断（非 root、无 `getuid`、`IS_SANDBOX=1`、真值 `CLAUDE_CODE_BUBBLEWRAP`），并覆盖各组合的单元测试。
- [x] 1.2 由 Session 按其实际环境决定是否向 Transport 传入 `allowDangerouslySkipPermissions`，Transport 不再自行按 uid 判断。

## 2. 不可用时的行为

- [x] 2.1 不可用时从 catalog 移除 `bypassPermissions`，保留其余原生模式与默认模式。
- [x] 2.2 显式创建或在 Claude Code 已启动后切换到 `bypassPermissions` 时返回 `unsupported`；恢复、回滚或启动前的恢复性选择降级为 `default` 并上报，保持 Thread 可打开。

## 3. 失败原因与展示

- [x] 3.1 将 CLI 的“未以绕过权限能力启动”和“被 settings 或组织策略禁用”映射为不可重试的明确错误，其余失败保持通用提示。
- [x] 3.2 Renderer 权限选择器在选择被拒绝后显示可见失败标记，并把原因写入悬停提示与无障碍标签。

## 4. 验证

- [x] 4.1 运行 Claude Adapter、Renderer 权限相关测试、TypeScript、lint 与格式检查，并在 root 环境用 SDK 复现原生拒绝。
