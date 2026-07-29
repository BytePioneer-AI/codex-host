## 1. Probe基线与依赖

- [x] 1.1 添加精确版本的官方Claude Agent SDK及必需peer开发依赖，不把SDK加入生产package依赖
- [x] 1.2 增加独立`gate:claude:*`命令和Git忽略证据目录约束，普通`npm run check`不调用本机Claude
- [x] 1.3 实现用户安装Claude可执行程序解析、版本/认证结构检查和脱敏诊断

## 2. Hermetic契约与测试

- [x] 2.1 定义Claude Probe场景结果、能力摘要和`PASS/FAIL/BLOCKED`判定结构
- [x] 2.2 实现完整Result终态分类、未知消息容忍和结构化事件摘要
- [x] 2.3 实现原生`structuredPatch`到确定性Unified Patch的转换与校验，不从Tool输入或文件状态推断
- [x] 2.4 添加合成Fixture和Hermetic测试，覆盖隐私字段拒绝、Result冲突字段、未知消息和Patch多hunk/CRLF

## 3. Inspect与无Prompt预热

- [x] 3.1 实现不调用模型的Inspect场景，只输出安装、登录可用性和SDK/CLI兼容结构
- [x] 3.2 实现SDK `startup()`无Prompt场景，验证关闭前后没有可恢复空Session和残留进程
- [x] 3.3 验证空`settingSources`与`user`设置源的认证差异并固化Native Mode配置结论

## 4. Live文本、历史与Fork

- [x] 4.1 实现显式Live开关、临时cwd、预算限制、调用方Session/User UUID和本地原始证据写入
- [x] 4.2 验证同一Query多Turn、完整终态、调用方User UUID历史稳定性和未知事件记录
- [x] 4.3 验证新进程Resume保持来源身份与历史追加
- [x] 4.4 验证`forkSession(upToMessageId)`精确截止、来源不变和派生UUID重映射

## 5. Live Tool、Interaction与Cancel

- [x] 5.1 验证Read/Edit Tool关联、Edit Permission Callback和原生`structuredPatch`可靠性
- [x] 5.2 验证`AskUserQuestion`结构化回答并证明Question与普通Tool Approval语义分离
- [x] 5.3 验证streaming和运行中Tool Interrupt、原生终态、子进程/副作用清理及同Session继续
- [x] 5.4 验证Pending Interaction取消会关闭AbortSignal且不泄漏回调或重复终态

## 6. 调查结论与边界

- [x] 6.1 编写带来源引用的`调查结论.md`，记录官方SDK、本机Claude和Paseo对照结论
- [x] 6.2 明确后续最小ClaudeCodeAdapter建议、Tool/Cancel公共契约反馈和仍未验证事实
- [x] 6.3 记录Anthropic法律、分发、第三方OAuth和程序化计费为独立发布前决策，不把Paseo说明当作政策事实源

## 7. 验证与审计

- [x] 7.1 运行Hermetic测试、Inspect、受控Live场景和脱敏报告生成
- [x] 7.2 运行`npm run check`、`npm run build`和独立OpenSpec strict validation，记录未执行或环境阻塞项
- [x] 7.3 审计Git状态，确认Paseo引用、原始Capture、Transcript、Prompt、账号、完整ID和本地路径未进入版本控制
- [x] 7.4 审计变更未修改HarnessAdapter、PiAdapter、Protocol Core、Host Runtime、Renderer、Mapping Store或产品路由
