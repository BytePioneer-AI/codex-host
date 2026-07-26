## 1. 基线与Gate边界

- [ ] 1.1 记录Gate A可复用的App/CLI发现、Shim、进程监督和官方CLI定位入口，以及Paseo的草稿/单Request模式、CodexPlusPlus的direct CDP/出站边界证据和AGPL独立实现边界
- [ ] 1.2 建立`tools/gate-b/`最小职责目录、`.codexhost/gate-b/`忽略运行目录、`tests/fixtures/gate-b/`allowlist、平台限定结果Schema和Gate命令
- [ ] 1.3 确认普通`npm run check`只运行Hermetic/Fixture测试，不启动Desktop、CDP、官方CLI、Pi或网络

## 2. 草稿状态与单Request契约

- [ ] 2.1 实现Gate-local strict `CreateRequestId`、`CreateThreadIntent`和namespaced Request扩展Schema，不定义Bridge消息或carrier fallback
- [ ] 2.2 实现按Composer隔离的`draft → creating → sent/abandoned`生命周期、发送时最终Harness/Model/Thinking/cwd快照、重复提交拒绝、失败后新ID重试和页面重载废弃旧草稿
- [ ] 2.3 增加最终快照、双草稿隔离、重复提交、失败重试、非法Intent和重载清理的确定性测试，不固定测试数量

## 3. Gate启动与最小direct CDP

- [ ] 3.1 为Gate启动路径增加Windows/macOS本次进程级remote debugging参数，保留已有实例拒绝、临时`CODEX_HOME`、synthetic cwd和有界清理
- [ ] 3.2 实现最小direct CDP target查询、WebSocket连接和进程/target type/页面行为确认；不能可靠确认时输出`BLOCKED`
- [ ] 3.3 使用`Page.addScriptToEvaluateOnNewDocument`和`Runtime.evaluate`完成当前document注入、同document幂等检查、重载后重新确认和Browser Target边界测试
- [ ] 3.4 明确`CODEX_HOME`只隔离官方CLI数据；限制CDP操作，不采集无关DOM、账号、项目列表、Local Storage、完整Console、网络流量或截图

## 4. 单一出站边界与JSONL Observer

- [ ] 4.1 在Gate A Shim的app-server分支中路由受监督Node JSONL Observer，其他CLI调用继续透明进入当前安装对应的官方CLI
- [ ] 4.2 在隔离Desktop捕获真实首次发送的创建Method、统一出站边界、Response Thread ID位置和首个Turn顺序；不可可靠定位或同步修改Request时报告`BLOCKED`
- [ ] 4.3 在该出站边界把完整CreateThreadIntent写入同一个创建Request的Gate-only namespaced扩展，不实现独立Intent通道、自定义Method、synthetic model或第二carrier
- [ ] 4.4 让Observer strict校验并提取完整Intent、在官方转发前移除扩展，并保持其他字段和无关JSONL line的顺序与内容
- [ ] 4.5 按原JSON-RPC `id`关联真实Response Codex Thread ID和Harness；Pi标记Thread的首个`turn/start`必须在官方Codex Agent Loop前返回受控Gate错误
- [ ] 4.6 增加扩展提取/移除、缺失或非法Intent拒绝、透明转发、错误Harness Turn阻止、交错Request/反序Response、进程错误清理和Fixture隐私测试

## 5. 五类真实Gate场景

- [ ] 5.1 运行CDP注入与重载场景，验证正确target、同document幂等注入、新document重新注入和旧草稿废弃
- [ ] 5.2 运行真实首发场景，证明完整Intent随同一个真实创建Request到达Observer、官方转发前扩展已移除、取得真实Response Codex Thread ID且Pi标记的首个Turn未进入官方Codex Agent Loop
- [ ] 5.3 运行同一Composer快速Codex/Pi切换场景，证明Request只包含发送时最终选择
- [ ] 5.4 运行两个窗口或可区分Composer的相反Harness并发场景，交错发送和反序完成仍各自正确；无法形成场景则报告`BLOCKED`
- [ ] 5.5 运行受控创建失败、新ID重试和Renderer重载场景，证明新Request不复用失败ID或旧草稿

## 6. PASS后契约提升与收敛

- [ ] 6.1 仅在当前平台五类真实场景全部`PASS`后，将`CreateRequestId`和strict `CreateThreadIntent`提升到`packages/shared-contracts`并增加公共入口、Runtime和Browser bundle测试
- [ ] 6.2 提交经过Schema和隐私测试的Gate B allowlist Fixture及平台限定报告，排除Prompt、Transcript、DOM、截图、真实ID、路径、环境、token和用户配置
- [ ] 6.3 更新技术架构、工程落地、开发步骤和独立Gate B验证记录，明确观察到的是Codex Thread ID，Mapping Store/P1仍负责`MVP-20`
- [ ] 6.4 运行最窄Gate B/Shared Contracts测试、现有Gate A回归、`npm run check`、`npm run build`、`npm run test:e2e`和两条strict OpenSpec validation，记录实际通过、跳过或阻塞结果
