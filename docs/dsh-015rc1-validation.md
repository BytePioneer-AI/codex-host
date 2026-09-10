# DSH 012rc1 / 015rc1 对接验证

实现基线为 upstream `9d36363f`，在 Windows、Node.js `v24.11.0`、npm `11.8.0`、Vitest `4.1.10` 下验证。当前仅支持精确 `0.1.2-rc.1` 与 `0.1.5-rc.1`；旧 DSH Legacy 实现、SDK 和专属测试已删除。

## 自动化测试与覆盖率

执行 `npm run test:deepseek:coverage`，整个 DSH Adapter 的 **813 项测试 / 22 个文件全部通过**。范围为 `packages/adapters/deepseek-harness/src/**/*.ts`，包含未执行文件；未把统计缩小到新增代码，四项门槛均为 80%。

| 指标 | 覆盖率 | 已覆盖 / 总数 |
| --- | --- | --- |
| 语句 | 86.52% | 5533 / 6395 |
| 分支 | 81.94% | 4743 / 5788 |
| 函数 | 92.99% | 889 / 956 |
| 行 | 89.01% | 5136 / 5770 |

HTML 和 JSON 摘要由同一命令生成到 `coverage/deepseek-harness/`，不纳入 Git。函数覆盖率超过 90% 保留，不删除有效测试来降低数字。

重点覆盖精确版本拒绝、端点认证诊断、选择/关闭并发、V0/V3 格式隔离、系统 surface 与替换、PTC/反馈/队伍事件、Assistant 流与结算重试、重连、Fork/回滚、继承队列清理、原生持久化确认，以及模型、权限、工具、Usage 和错误边界。实际 Host 输出还经 `CodexTurnProjector` 回放，确认取消尝试的可见标记及追加/完成一致性。

额外定向检查：

- Host 导入、共享契约、插件加载与打包：7 个文件、72 项通过。
- Session/Adapter 与 Protocol Core 投影、Renderer 设置/本地化/绑定回归：7 个文件、248 项通过（其中 Adapter 测试与上表重叠，不重复汇总为总数）。
- `npm run build:typescript`、`npm run typecheck`、`npm run lint`（含包边界）通过。
- 改动文件 Prettier、`git diff --check` 与本变更及三个主规范的 OpenSpec strict 校验通过。

## 真实 CLI 生命周期

执行 `tools/gate-dsh/lifecycle.real.test.mjs`，分别指定两个准确版本的 `CODEXHOST_DSH_REAL_COMMAND`。012 使用本机已安装 CLI；015 通过 `npm install --prefix .cache/dsh-015rc1 @deepseek-ai/dsh@0.1.5-rc.1 --no-audit --no-fund` 隔离安装，并先执行 `--version` 确认。

```powershell
$env:CODEXHOST_DSH_REAL_COMMAND = '<准确版本的 dsh.cmd 绝对路径>'
npx vitest run --config tests/vitest.config.js tools/gate-dsh/lifecycle.real.test.mjs
```

两个版本各 1 项真实生命周期 Gate **均通过**。Gate 启动真实 DSH Web/Remote、临时 `DSH_HOME` 和本地 SSE 模拟模型，使用自己的探测端点；覆盖：

- 最终消息之前已有增量文本、原生取消及 HTTP 流停止。
- 单回合回滚为空会话、多回合回滚保留前缀，默认模型/Thinking/权限保持。
- 关闭后冷恢复并继续新输入，源会话历史不变、请求无重叠。
- 活动 Session 关闭必须确认原生终态。

真实 015 Gate 发现并验证了两项必要修复：原生 Fork 继承的待办需要通过原生队列接口取消；原生 200ms 批量写入需要通过 export HEAD flush barrier 确认，避免 Windows 结束进程后重放已回滚输入。未用固定延时掩盖持久化问题。

## 协议源码证据

参考 DSH `dsh-v0.1.5-rc.1` 标签（`183f08e9c6dde7e36cd2318eaee70b0da08fb35e`），并与 `dsh-v0.1.2-rc.1` 对比。测试样本 `packages/adapters/deepseek-harness/test/fixtures/dsh-015rc1-empty-response-retry.v3.jsonl` 原样取自该标签的 `snapshots/session/empty-response-retry-current/session.v3.jsonl`，由 DSH 自己记录并脱敏，包含系统消息、请求头、空响应重试、独立 Assistant attempt 和最终消息。

原生快照省略事件 `seq`/`time`，并以 `{{...}}` 替换机器环境。回归测试只补回连续序号及固定时间，并把 `{{tools}}` 替换成最小合法工具声明；保留原始事件名、字段、顺序、系统消息来源和 Assistant 压缩流。此样本用于协议解析，不代表真实模型或桌面验证。

- `core/session/src/types.ts`、`api/session-controller/src/types.ts`：V3 日志、系统消息和 Assistant stream。
- `interaction/commands/src/index.ts`：015 `submittedAttachments` 参数。
- `api/session-controller/src/commands.ts`：Fork 原生前缀、队列 remove 与 cancel 的不同语义。
- `core/agent-loop/src/inbox.ts`：原生持久化 Inbox 投影。
- `session/session-persistence-jsonl/src/storage.ts`：批量写入和 flush。
- `session-query/session-log-export/src/index.ts`、`archive.ts`：认证 HEAD 响应之前等待原生 flush。

未使用浏览器自动化、computer use 或真实计费模型；未启动用户桌面、修改参考 DSH 源码或用户会话。未运行未受影响的 Rust 全套测试；模型提供商、第三方客户端和全部操作系统的组合不包含在本次验证内。
