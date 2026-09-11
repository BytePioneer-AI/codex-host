# DSH 012rc1 / 015rc1 对接验证

## 原生子智能体接入（2026-09-11）

本轮基线为 upstream `23a9efa7`，Windows、Node.js `v24.11.0`、npm `11.8.0`、Vitest `4.1.10`。版本白名单保持精确 `0.1.2-rc.1` 与 `0.1.5-rc.1`；默认本地 `subagent`／`subagent_fork` 的能力与限制见 [DSH 原生子智能体](dsh-subagents.md)。下文旧版对接与 CodeRabbit 记录为此前验证，不计入本轮检查次数。

完整 DSH Adapter 覆盖率范围和四项 80% 门槛保持不变；先执行 `npm run build:typescript`，再执行 `node node_modules/vitest/vitest.mjs run --config tests/vitest.deepseek-coverage.config.js`，**888 项测试／23 个文件通过**。

| 指标 | 覆盖率 | 已覆盖 / 总数 |
| --- | --- | --- |
| 语句 | 87.08% | 6129 / 7038 |
| 分支 | 82.59% | 5248 / 6354 |
| 函数 | 92.58% | 986 / 1065 |
| 行 | 89.60% | 5687 / 6347 |

覆盖版本／父子身份拒绝、原生地址、实时子文本与工具、后台状态和真实终态、并发冷读／恢复父会话、目录发现与工具完成竞态，以及首次子观察前的父关闭和关闭失败。公共 Host 的 166 项聚焦回归通过，覆盖原生协作卡片、子列表、只读详情、运行状态、冷恢复快照更新与后代通知隔离。

真实 CLI Gate `tools/gate-dsh/subagents.real.test.mjs` 在隔离 `DSH_HOME` 和本地 SSE 模型下分别验证两个准确 RC：**012 6/6、015 6/6 通过**，耗时分别为 44.85 秒、62.21 秒。覆盖默认后台、前台 Fork、失败、中断、父 Turn 取消保留子工作、父 Session 关闭及持久化、发送后续消息、冷读／恢复，以及临时搬移 Bundle 经真实 `loadHarnessPlugins` 工厂加载。012 快速失败和 015 搬移插件的直接 Adapter 关闭再各连续执行三次，全部通过；共 18 次实际场景执行。首次子观察前关闭另由双版本确定性回归验证。

本轮 `npm run build:typescript`（含独立插件打包）、`npm run typecheck`、`npm run lint`（含包边界）、`npm run format:check`、`git diff --check` 和 OpenSpec strict 校验通过。生成的日志、覆盖率、CLI 安装和 Bundle 均不纳入 Git。

PR 精简保留全部测试场景与断言，合并事件包装、输出收集、重复状态断言和生产代码中的完成事件转发，共减少 114 行代码（生产 14 行、测试 100 行）。精简后再次执行完整 DSH 覆盖率、两版真实 Gate（各 6/6）和上述静态检查均通过；上表为精简后的覆盖率。

复用公共子智能体协议和现有预装插件加载机制，未修改 Renderer、Manifest 或发行依赖。未执行 Desktop 视觉操作、浏览器自动化、computer use、计费模型、SSH／Remote Control 或其他操作系统验证；未运行未受影响的 Rust 测试。跨进程 provider 的内部对话／工具流仅在 DSH 原生暴露记录时可见，不承诺补出缺失记录。

## 此前 012rc1 / 015rc1 协议对接

实现基线为 upstream `9d36363f`，在 Windows、Node.js `v24.11.0`、npm `11.8.0`、Vitest `4.1.10` 下验证。当前仅支持精确 `0.1.2-rc.1` 与 `0.1.5-rc.1`；旧 DSH Legacy 实现、SDK 和专属测试已删除。

## 自动化测试与覆盖率

执行 `npm run test:deepseek:coverage`，整个 DSH Adapter 的 **820 项测试 / 22 个文件全部通过**。范围为 `packages/adapters/deepseek-harness/src/**/*.ts`，包含未执行文件；未把统计缩小到新增代码，四项门槛均为 80%。

| 指标 | 覆盖率 | 已覆盖 / 总数 |
| --- | --- | --- |
| 语句 | 86.52% | 5537 / 6399 |
| 分支 | 81.95% | 4746 / 5791 |
| 函数 | 92.98% | 888 / 955 |
| 行 | 89.01% | 5139 / 5773 |

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

## CodeRabbit 复核修复

整数校验现通过既有协议错误类型失败，非法 chunk 索引及 finish 的 status/providerRetryAfterMs 保持 `protocolError`，不触发 journal 重连。Assistant start 的结算查找改为从 `startedAfterSeq + 1` 按索引遍历，保留匹配条件，不复制历史数组。

补充测试先复现旧实现的错误，再验证修复；167 项聚焦回归与上述 820 项全 Adapter 测试通过。性能回归断言不访问已排除的历史前缀，不使用依赖机器速度的耗时阈值。本轮未重复运行此前已通过的真实 CLI 生命周期 Gate。
