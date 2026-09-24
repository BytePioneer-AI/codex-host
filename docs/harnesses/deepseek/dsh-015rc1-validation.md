# DSH 012rc1 / 015rc1 / 015rc2 / 015rc3 / 017rc1 对接验证

## 本次版本扩展验证（support-dsh-015rc3-017rc1）

本次变更新增两个隔离 release：`dsh-v0.1.5-rc.3`（`a4c74a91e06b00fe0b0937bde982170c526cc842`）和 `dsh-v0.1.7-rc.1`（`46a7f68b0922371ce7144b668b90e377d8e799f4`）。前者沿用 V3 Session 日志和既有 V3 Remote 语义；后者使用 V4 Session 日志，Adapter 以独立 profile 校验 V4 header、`developer/message`、surface 引用、image offload、workspace changes、Assistant 流块和 Fork 的 `forked` synthetic closer。

`0.1.5-rc.3` 和 `0.1.7-rc.1` 的真实 CLI 生命周期 Gate 均已通过，覆盖托管 Web 启动、inspect/create、流式增量、取消及 HTTP 停止、空/保留历史回滚、冷恢复、继续输入、活动关闭和请求无重叠。两个版本均使用精确 npm 隔离的 `dsh.cmd`，没有把 `--version` 成功当作对接证据。

真实 Gate 环境为 Windows、Node.js `v24.11.0`、npm `11.8.0`、Vitest `4.1.10`。命令模板如下（`<TEMP>\rc3` 或 `<TEMP>\rc1` 替换为对应精确版本的隔离目录）：

```powershell
$env:CODEXHOST_DSH_REAL_COMMAND = '<TEMP>\rc1\node_modules\.bin\dsh.cmd'
.\node_modules\.bin\vitest.cmd run --config tests/vitest.config.js tools/gate-dsh/lifecycle.real.test.mjs --reporter=verbose
```

最终复跑结果：`dsh-v0.1.5-rc.3` 为 1/1 通过（Vitest 11.49 秒），`dsh-v0.1.7-rc.1` 为 1/1 通过（Vitest 8.20 秒）。两个 Gate 均使用本地 SSE 模拟模型和隔离临时 `DSH_HOME`，不调用真实计费模型。真实 Gate 不覆盖原生 V4 Fork 或真实模型的工具调用；这些协议边界由下面的定向回归检查。

V4 `session/follow` 的 Web snapshot 对顶层 Session 省略 `delegationDepth`，Adapter 按 DSH Web 实际契约将缺省值规范化为 `0`；显式提供的值仍必须是非负安全整数。

本次执行 `npm run test:deepseek:coverage`，整个 DSH Adapter 的 **843 项测试 / 23 个文件全部通过**；范围仍为 `packages/adapters/deepseek-harness/src/**/*.ts`，四项 80% 门槛均通过。

| 指标 | 覆盖率 | 已覆盖 / 总数 |
| --- | --- | --- |
| 语句 | 86.22% | 5758 / 6678 |
| 分支 | 81.85% | 5063 / 6185 |
| 函数 | 92.92% | 919 / 989 |
| 行 | 88.97% | 5351 / 6014 |

协议和 profile 的定向回归已覆盖 V3/V4 合法与非法历史、developer 工具引用、Assistant stream、Fork 边界、原生 `forked-tool-result` 的校验与投影、跨格式 checkpoint、控制读回、分页和实时去重。V4 checkpoint 使用 `v4-turn-end:` 前缀及精确版本 locator；V3/V0 或迁移前 checkpoint 在 mutation 前拒绝。DSH 原生 Session、凭据和迁移仍由 DSH 所有，codexhost 不读取或改写原生日志文件。

本次 `npm run build:typescript`、`npm run typecheck`、`npm run lint`、`npm run format:check`、OpenSpec strict 和 `git diff --check` 均通过。未使用真实计费模型、Desktop 或浏览器自动化，也未在其他平台运行本次新增版本的真实 Gate。

实现基线为 upstream `9d36363f`，在 Windows、Node.js `v24.11.0`、npm `11.8.0`、Vitest `4.1.10` 下验证。本节所述原始基线仅支持精确 `0.1.2-rc.1` 与 `0.1.5-rc.1`；旧 DSH Legacy 实现、SDK 和专属测试已删除。

## 自动化测试与覆盖率

执行 `npm run test:deepseek:coverage`，整个 DSH Adapter 的 **820 项测试 / 22 个文件全部通过**。范围为 `packages/adapters/deepseek-harness/src/**/*.ts`，包含未执行文件；未把统计缩小到新增代码，四项门槛均为 80%。

| 指标 | 覆盖率 | 已覆盖 / 总数 |
| --- | --- | --- |
| 语句 | 86.52% | 5537 / 6399 |
| 分支 | 81.95% | 4746 / 5791 |
| 函数 | 92.98% | 888 / 955 |
| 行 | 89.01% | 5139 / 5773 |

HTML 和 JSON 摘要由同一命令生成到 `coverage/deepseek-harness/`，不纳入 Git。函数覆盖率超过 90% 保留，不删除有效测试来降低数字。

上述原始基线覆盖精确版本拒绝（当前已改为 SemVer 探测与协议校验，见下文连接版本策略）、端点认证诊断、选择/关闭并发、V0/V3 格式隔离、系统 surface 与替换、PTC/反馈/队伍事件、Assistant 流与结算重试、重连、Fork/回滚、继承队列清理、原生持久化确认，以及模型、权限、工具、Usage 和错误边界。实际 Host 输出还经 `CodexTurnProjector` 回放，确认取消尝试的可见标记及追加/完成一致性。

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

## 0.1.5-rc.2 适配与验证边界

`0.1.5-rc.2` 复用 V3 profile；Fork checkpoint 的 `dshVersion` locator 仍要求精确版本匹配，同为 V3 的 Session Ref 则可跨 CLI 版本尝试恢复。上游开源标签 [`dsh-v0.1.5-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.5-rc.2)（`fb2c4b9e`）与 rc.1（`183f08e9`）比较，Web、Session、Agent、命令及日志协议实现均未改变；非版本元数据的生产源码改动只涉及反馈类型的注释。因此 V3 解析器没有新增分支，未承诺未来版本兼容。

本机全局 `@deepseek-ai/dsh@0.1.5-rc.2` 的依赖声明使用 `^0.1.5-rc.2`，npm 实际安装了部分 `0.1.5-rc.3` 的子包。隔离临时 `DSH_HOME`、本地模拟模型的真实 CLI Gate 在 Web 启动阶段失败：`@deepseek-ai/dsh-sandbox-local` 未能加载；没有执行到 Session 生命周期断言。`dsh --version` 和 `dsh --help` 成功不证明 Web 可启动。另在 `/tmp` 用 npm overrides 精确安装 rc.2 DSH 子包后再次运行 Gate，Web 已输出启动 URL，但仍在启动阶段因 `user patch-layer watching requires the Cordis HMR service` 退出；即使固定 HMR 包为 `1.0.17` 仍复现。两次均未执行到 Session 生命周期断言。随后在用户目录隔离安装并精确固定 rc.2 DSH 子包、`@deepseek-ai/cordis@4.0.2` 与 `@deepseek-ai/cordis-plugin-hmr@1.0.17`，以 DSH 原生 `initProfile` 将 Gate 的临时 Web profile 设为 `patchReload: startup`（不更改 Gate 的其他路径）。macOS arm64、Node.js `v24.18.0` 下真实 CLI 生命周期 Gate **1/1 通过**，覆盖前述流式、取消、编辑、恢复和关闭；复跑仍 1/1 通过。原始全局安装未删除，`dsh` 可执行文件的原始 symlink 已备份，用户 Web profile 修改前也已备份。正在运行的托管 Web 在修改后持续监听回环端口，并返回预期的无凭据 401 指纹。此处的 `startup` 关闭 profile patch 的实时热重载；默认 `live` 在本机仍因 HMR 服务缺失失败。npm 未批准的安装脚本不计入测试结果，其他原生模块组合尚未完整验证；此前 Windows 验证仅覆盖 rc.1/012。

## 连接版本策略

连接不再仅按 `--version` 白名单拒绝：接受单行规范 SemVer，`0.1.2` 系列尝试 V0，精确 `0.1.7-rc.1` 选择 V4，其余尝试 V3；Web Remote、历史和流式数据仍由原生协议解析器严格验证。V3 Session Ref 可跨 CLI 版本尝试恢复，格式不符时失败；Fork 的 checkpoint 仍需匹配创建它的精确 CLI 版本，避免在未知原生迁移后按旧序号修改历史。设置 → 连接显示五个**已测试**版本，未测试版本不宣称兼容。本策略的自动化测试只证明版本探测、路由及模拟原生协议行为；真实生命周期证据仅限于上文列出的各版本，不涵盖其他版本。

## CodeRabbit 复核修复

整数校验现通过既有协议错误类型失败，非法 chunk 索引及 finish 的 status/providerRetryAfterMs 保持 `protocolError`，不触发 journal 重连。Assistant start 的结算查找改为从 `startedAfterSeq + 1` 按索引遍历，保留匹配条件，不复制历史数组。

补充测试先复现旧实现的错误，再验证修复；167 项聚焦回归与上述 820 项全 Adapter 测试通过。性能回归断言不访问已排除的历史前缀，不使用依赖机器速度的耗时阈值。本轮未重复运行此前已通过的真实 CLI 生命周期 Gate。
