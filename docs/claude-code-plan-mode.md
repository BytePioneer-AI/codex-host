# Claude Code 规划模式与计划确认

Claude Code SDK 原生支持 `permissionMode: "plan"` 和运行中的 `setPermissionMode("plan")`。codexhost 直接使用这些接口，不通过提示词模拟权限模式。

## 用户可见行为

规划模式是一种先探索、制定计划，再确认执行的工作流，不是“所有工具一律禁用”。Claude 可以读取、搜索和写入计划文件；工具权限仍由 Claude Code 执行。

Claude 调用 `ExitPlanMode` 时，codexhost 展示独立的 **Review plan** 选择式确认，而不是普通工具的“允许一次”审批：

- 展示 SDK 回调提供的完整计划正文，不套用普通工具审批的 500 字符描述截断。
- **Stay in plan mode（保持规划）** 位于第一个选项，拒绝本次退出规划请求。
- **Approve plan and exit plan mode（批准计划并退出规划）** 明确批准计划并允许原生退出操作。Claude Code 随后恢复进入规划前的权限模式，并可能继续执行计划。
- 取消确认等同于拒绝退出。任意文本、未声明选项、多选和缺失答案都不能批准退出。
- SDK 未提供非空计划正文时，只提供“保持规划”。codexhost 不根据工具参数中的文件路径自行读取文件，也不会批准无法展示的计划。

普通 `Write`、`Edit`、`Bash` 审批仍使用原有的允许一次、拒绝，以及 SDK 明确提供的会话或持久授权选项。计划退出确认不提供会话或永久授权，也不应用 SDK 权限建议中的批量权限更新。

## 所有权与投影

- `packages/adapters/claude-code/src/sdk-transport.ts` 识别原生 `ExitPlanMode`，保留计划正文与原生回调的关联；确认后返回 `allow`，保持规划或取消时返回 `deny`。
- `packages/adapters/claude-code/src/plan-review.ts` 将计划审批转换成封闭的 Host Question，并把经过验证的回答转换回原生权限决定。它不是 Claude 的 `AskUserQuestion` 工具调用，也不会把选择结果写进原生工具的 `answers` 参数。
- Codex Desktop 的普通 MCP 工具审批面板固定显示“允许一次”。因此复用现有 `item/tool/requestUserInput` 选择式交互展示明确的退出含义，而不是依赖修改 `HostApprovalAction.label` 或私有 DOM。
- 模式变化仍以 SDK 的原生状态通知为准。Adapter 不在批准、拒绝或取消时自行调用 `setPermissionMode`，也不会在 Claude 已退出规划后强制切回规划。

确认文案目前使用英文，与 Adapter 的其他固定交互文案保持一致；权限模式下拉菜单提供中英文说明。

## 验证

定向回归覆盖 SDK 回调区分、完整计划保留、无计划时禁止批准、批准/保持/取消响应、非法响应、重复响应以及普通工具审批保持不变：

```sh
npx vitest run --config tests/vitest.config.js \
  packages/adapters/claude-code/test/sdk-transport.test.ts \
  packages/adapters/claude-code/test/claude-code-adapter.test.ts \
  packages/renderer-extension/test/renderer-permission-mode-picker.test.ts
```
