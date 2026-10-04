## 1. 契约

- [x] 1.1 `harness-adapter` 与 `harness-broker` 事件白名单：新增 `usage.request`（`requestId`、可选 `model`/`provider`/`historical`/`outputStartedAtMs`/`completedAtMs`、统一口径与“缓存已知为零填 0”约束）与 `usage.history { complete }` 输出事件及校验。
- [x] 1.2 `HostUsage` 与 `threadUsageSnapshotSchema` 新增 `sessionCacheHitRatePercent`、`timeToFirstOutputMs`、`costSource` 及校验。

## 2. 价格表

- [x] 2.1 构建脚本从 models.dev 生成精简快照并随版本打包。
- [x] 2.2 Host 价格表模块：加载快照/本地缓存，启动时超过 7 天后台刷新，失败静默；读取用户覆盖文件；精确查找与官方服务商判定。

## 3. Host 计量

- [x] 3.1 计量状态：按 Thread 保存请求记录，按 `requestId` 去重；以首个 `usage.history` 进入计量模式并忽略原生费用；跟踪完整性（运行中 `complete: false` 或记录校验失败即不完整）。
- [x] 3.2 派生指标：按当前价格表重算费用（无法计费时省略）、会话平均缓存命中率、`costSource`。
- [x] 3.3 首字延迟；按记录自带计时计算回合平均速度（排除缺计时、零时长、迟到与历史记录）。
- [x] 3.4 在 External Thread 事件处理处接入；只写派生字段；过期 Session、替换、删除、关闭时丢弃状态；计量异常不影响会话。

## 4. Adapters（第一批：Pi、OMP、OpenCode v2）

- [x] 4.1 Pi、OMP：每条 assistant message 发布请求记录（加回缓存；消息 ID 作 `requestId`；按同一 message 的事件给出计时；排除子代理）；打开时回放原生历史全部请求（含所有分支），发布 `usage.history`。
- [x] 4.2 OpenCode v2（`packages/adapters/opencode/src/v2`）：每个 assistant message 发布记录（`session.step.ended` 的 tokens，加回缓存、加入思考；消息 ID 作 `requestId`；模型取 `step.started` 的 `model`）；打开时按 `message.list` 回放全部请求并发布 `usage.history`。标题/压缩的 `session.usage.recorded` 不计入；失败步骤仅带 Token 时计入。v1 协议不接入。
- [x] 4.3 以合成数据覆盖：创建、恢复、分叉、换模型、重复事件、历史不完整。

## 5. 界面与文档

- [x] 5.1 用量浮窗新增“平均缓存命中”“首字延迟”，费用行按 `costSource` 说明计算方式。
- [x] 5.2 更新 `docs/` 中用量相关文档。

## 6. 验证

- [x] 6.1 单测：口径换算、计费公式、无法计费、价格刷新重算、覆盖文件、去重、分叉与撤销后的回放、运行中缺口、缓存未知、未接入与计量模式、过期 Session、速度计时。
- [x] 6.2 用本机 Pi、OpenCode v2 实测，对比原生用量与 Host 计算结果。
- [x] 6.3 运行 typecheck、lint、相关测试与 `openspec validate add-host-usage-metering --strict`。

## 7. 后续批次（本变更之外跟进）

- [ ] 7.1 Claude Code（先确认 Turn 末输入骤降）、CodeBuddy/WorkBuddy（缓存字段）、DeepSeek、Kimi、Qoder。
- [ ] 7.2 Grok、ZCode、Hermes、Antigravity：合计型或模型归属不明确，按 D2 只计 Token，实测口径后接入。
