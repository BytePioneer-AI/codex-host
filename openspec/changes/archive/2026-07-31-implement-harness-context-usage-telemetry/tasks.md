## 1. 实施上下文与公共契约

- [x] 1.1 按`docs/开发步骤清单.md`实施前规则复读相关主spec、归档design、验证记录、当前源码与测试，确认Usage契约和现有模块边界一致
- [x] 1.2 先在Harness Adapter契约测试中增加`HostUsage`有效/无效数值、context pair、`initialUsage`、完整替换、`null`清除和Turn终态后Usage事件场景
- [x] 1.3 在`packages/harness-adapter`实现严格Usage类型、`SessionUsageChangedEvent`、`HarnessSession.initialUsage`和公共导出，保持`HarnessSessionState`与capabilities不变
- [x] 1.4 扩展`FakeHarnessSession`与测试控制API，支持初始Usage、Turn中/Turn后更新、失效清除、Telemetry失败和两个Fake Harness隔离

## 2. Pi原生Usage Producer

- [x] 2.1 为Pi私有transport增加Fake JSONL测试，覆盖完整`get_session_stats`、context-only、非负safe integer/成本校验、malformed、timeout、明确unsupported和非unsupported错误
- [x] 2.2 实现私有`PiSessionStats`解析与`getSessionUsage()`，映射Token、cost和`contextUsage`，只在明确unsupported时回退扩展后的`get_state.contextUsage`
- [x] 2.3 在Pi Harness Session实现`initialUsage`：lazy create保持`null`，resume执行一次有界Native Session统计读取，失败不阻止恢复
- [x] 2.4 实现按Native Session/Model generation保护的异步Usage刷新器，在稳定输入终态、Compaction和Model确认边界刷新，并在身份改变时清除不适用快照
- [x] 2.5 增加Pi Adapter聚焦测试，覆盖首次/连续Turn、无Agent Loop命令、自动或手动Compaction、Model改变、旧结果丢弃、查询失败保留、close有界和Session隔离

## 3. Codex Usage协议投影

- [x] 3.1 固化当前官方生成Schema中`thread/tokenUsage/updated`、`TokenUsageBreakdown`和`modelContextWindow`的最小评审合成结构，普通测试不得依赖本机Codex Binary
- [x] 3.2 在Protocol Core先增加纯投影测试，覆盖aggregate映射、context carrier关系、必填占位字段、缺失total/context/Turn时省略及输入不可变
- [x] 3.3 实现独立`projectCodexThreadUsage`并从Protocol Core公共入口导出，确保Codex字段名不进入Harness Adapter或Pi Adapter
- [x] 3.4 回归Codex透明代理，证明官方`thread/tokenUsage/updated`仍原样转发且不会经过External Usage projector

## 4. 通用External Thread Usage状态

- [x] 4.1 在External Thread Runtime增加只属于已加载Session的`latestUsage`和关联Turn状态，从`initialUsage`初始化并在replace/delete/close时丢弃
- [x] 4.2 让Host输出消费者处理`session.usage.changed`，按显式Turn、active Turn、latest completed Turn选择关联，校验旧Session不能覆盖replacement
- [x] 4.3 将External Usage通知接入现有response-before-notification gate，并允许Session级Usage在Turn terminal后独立投影而不重新进入`CodexTurnProjector`
- [x] 4.4 在`thread/read`恢复/重访响应后重放当前Usage到最近已对齐Turn；没有可靠Turn或完整context时只缓存不通知
- [x] 4.5 增加双Fake Host测试，覆盖Pi/非Pi共用路径、早到事件、terminal后事件、resume、read重放、Session替换、缺失Usage、错误隔离和未注册Harness不回落Codex
- [x] 4.6 增加Mapping Store故障/序列化断言，证明Usage、cost和context历史不进入Stored Thread Record、Native Ref、Turn Mapping或Fork Anchor

## 5. Renderer边界与组合回归

- [x] 5.1 增加受支持Renderer/Host静态回归，证明External Usage只使用原生Codex通知，不新增第二个表盘、Pi轮询、通用Request bridge或Model carrier解析
- [x] 5.2 增加合成Pi到Host集成测试，证明同一External Thread的Turn response、Usage通知、terminal、idle和后续Turn保持确定顺序
- [x] 5.3 回归Model选择与Thread恢复，确认Usage刷新不改变Harness归属或既有Model控制行为

## 6. 真实协议与Desktop Gate

- [x] 6.1 使用当前App内置Codex Binary显式生成临时Schema并核对Token Usage carrier；只提交结构结论，不提交生成目录、版本门禁或本地路径
- [x] 6.2 运行有界真实Pi smoke，在临时cwd/Session验证resume初始Usage、连续Turn、Compaction及Model改变后的context pair刷新；原始统计、成本、Model、Prompt和完整ID只留Git忽略证据
- [x] 6.3 在受支持真实Desktop中验证Pi Thread原生上下文表盘出现、数值关系匹配、连续Turn/Compaction更新和重访恢复，记录匿名ordinal与关系断言
- [x] 6.4 若当前Desktop展示carrier占位breakdown或原生表盘Gate失败，停止宣称UI能力并回到Protocol投影设计，不增加启发式DOM fallback

## 7. 文档与质量收敛

- [x] 7.1 同步`docs/HarnessAdapter技术设计文档.md`、`docs/技术架构设计文档.md`和`docs/开发步骤清单.md`，明确Session Usage scope、Paseo借鉴边界、非持久化和已执行Gate
- [x] 7.2 运行Harness Adapter、Pi Adapter、Protocol Core、Host Runtime和Renderer聚焦测试及各受影响package typecheck/lint/format检查
- [x] 7.3 运行`npm run check`、`npm run build`和`git diff --check`，仅记录实际执行结果与任何环境阻塞
- [x] 7.4 运行`openspec validate implement-harness-context-usage-telemetry --strict`并审计Git状态，确认Paseo引用、真实Capture、Session统计、Prompt、账号、完整ID和本地路径未进入版本控制
