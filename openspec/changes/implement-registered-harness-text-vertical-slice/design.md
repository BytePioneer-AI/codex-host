## Context

当前Pi链路已经形成正确的分层：具体Adapter实现HarnessSession，Host拥有请求路由和响应顺序，Protocol Core的`CodexTurnProjector`拥有Codex app-server形状，Renderer通过内部transport Model token绑定Composer选择。Tool/Cancel Change进一步证明Projector和HarnessSession事件已经与Pi原生协议解耦。

剩余问题集中在组合层：Protocol Core只识别Pi token，Host使用`PiThread/#piAdapter`和`"codex" | "pi"`类型，Renderer控件和Model状态也硬编码Codex/Pi。Claude Gate已经证明官方Agent SDK `0.3.220`与用户安装的Claude Code `2.1.220`可提供惰性预热、长期多Turn Query、streaming text、Interrupt、Native Session身份和有界关闭，但该证据尚未经过生产HarnessAdapter和真实Codex UI链路。

开发清单原计划只做Claude契约Adapter、不注册产品路由；本Change根据最新开发目标增加受控Codex UI纵向Gate。它不改变PRD中“Pi是公开MVP唯一外部Harness”的发布范围：Claude入口必须显式开发启用，默认Renderer和默认Host行为保持Codex/Pi。

## Goals / Non-Goals

**Goals:**

- 新增一个隐藏Claude SDK细节的具体HarnessAdapter，并通过现有text/cancel/fault/close契约测试。
- 把Host唯一外部Harness组合从Pi专用字段改为有限注册表，Pi和Claude复用同一Thread、响应Gate和Projector代码。
- 把transport token解码集中在Protocol Core，未知或未注册外部token fail closed，绝不回落官方Codex。
- 让受控Renderer Gate显式显示Claude Code并把选择绑定到独立transport token。
- 用Fake、真实SDK和真实Desktop分层证明链路，不记录Prompt、Transcript、完整ID或账号数据。

**Non-Goals:**

- 不扩展HarnessAdapter公共命令或事件类型，不增加原生escape hatch。
- 不在本切片投影Claude Tool、File Change、Question、Approval、Reasoning、Usage、MCP、Skills或Hooks。
- 不实现Snapshot、Mapping Store、跨重启Thread、Resume、Fork、Detach或Model Catalog。
- 不默认展示Claude、不加入公开发布包、不声明Windows支持，也不解决OAuth资格、计费或二进制重分发决策。
- 不复制Paseo Provider、Timeline或Diff推断实现。

## Decisions

### 1. 具体Adapter内部继续分离Transport与Harness生命周期

`packages/adapters/claude-code`包含两个主要责任：

- `ClaudeSdkTransport`拥有官方SDK Query、输入队列、消息运行时识别、Result分类、Interrupt、进程句柄和Native Session ID。
- `ClaudeHarnessSession`拥有Host Turn/Item ID、HarnessOutputChannel、acceptance、busy检查、唯一终态、Fault和Adapter Session集合。

Transport提供与Pi私有transport同层次的`start/runTurn/abort/close`接口；Host永远看不到SDK Query、SDKMessage、Permission Mode或Claude设置。这样可以用Fake Transport完整测试Adapter，而不在普通测试中启动Claude或读取用户配置。

Alternative：在Host直接消费SDK消息。拒绝，因为会恢复具体Harness知识并绕过公共契约。

Alternative：让生产Adapter导入`tools/gate-claude-code`。拒绝，因为Gate是开发证据工具，不是运行时所有者；生产模块独立实现并由Gate事实与测试约束。

### 2. 第一切片继承默认Tool，只投影共享文本和Cancel链路

SDK Query使用AsyncIterable输入维持一个Native Session的多Turn执行，显式设置用户安装的可执行文件、`settingSources: ["user"]`、`permissionMode: "dontAsk"`和client-app标识，并省略`tools`选项以继承Claude Code的默认工具集。`open(create)`不解析命令、不启动进程；第一个`turn.start`才解析可执行文件并初始化Query。

调用方预分配Session UUID和每Turn User UUID。初始化握手确认Query后，Adapter发布`session.state.changed`，再发布Turn/Agent Message lifecycle并写入User消息。多个顺序Turn复用同一Query。

默认Tool执行是当前开发Gate中的原生内部行为；本切片仍只投影Agent Message文本和Turn终态，不投影Tool、File Change或Interaction。`permissionMode: "dontAsk"`保持不变，因此未被当前原生配置预先允许的操作应由Claude Code拒绝，而不是在缺少Host审批桥接时等待交互。

### 3. Streaming delta优先，完整Assistant消息只做确定性补齐

Transport运行时识别`stream_event.content_block_delta.text_delta`并增量输出。完整Assistant文本到达时，只在它以已输出文本为前缀时追加剩余后缀；不能证明前缀关系时不重放全文，而把不一致作为native failure。Thinking、Tool块和未知消息不进入文本Item；未知消息本身不导致失败。

Result分类联合`subtype`、`is_error`、`terminal_reason`、Assistant error和本地cancel状态。`subtype=success`不是充分条件。每个Result只解析一次；Item在Turn前完成。

### 4. Interrupt只确认请求，Result才是Turn终态

`turn.cancel`校验当前Turn后调用`Query.interrupt()`并返回`cancellationRequested: true`。Transport继续消费，只有`aborted_streaming`或`aborted_tools`与已接受cancel同时成立时才产生cancelled；无法证明时failed。取消后Query仍可接收下一Turn。

`close()`复用cancel/finalization，关闭输入和Query，等待被Adapter拥有的Claude直系进程在时限内退出；超时升级终止。本切片尚未监督Tool/MCP后代进程，因此不声称任意Tool/MCP后代进程树已跨平台关闭。

### 5. Protocol Core维护有限transport路由表

Protocol Core导出：

```text
pi          <-> codexhost/pi-native
claude-code <-> codexhost/claude-code-native
```

`decodeCreateRoute()`返回`codex`或有限`ExternalHarnessId`。它不调用Adapter、不检查安装、不解析Claude模型。Host收到有效外部token但缺少对应注册时返回明确错误，不能把请求转发给官方Codex。

这是协议路由表，不是通用Provider框架；第三个真实Harness出现前不增加动态插件发现。

### 6. Host使用一个外部Harness注册表和一个Thread实现

`AppServerHost`以`ReadonlyMap<ExternalHarnessId, HarnessAdapter>`组合具体Adapter。未注入注册表时继续构造默认PiAdapter，保持现有调用方。生产`main.ts`显式构造Pi；只有`CODEXHOST_ENABLE_CLAUDE_CODE=1`时才构造并注册ClaudeCodeAdapter。

`ExternalThread`保存`harnessId`、transport token、HarnessSession、Projector和当前进程内Thread快照。create、turn、interrupt、read、rename、delete、close和Fault消费均只有一套实现。错误和诊断使用Harness ID，不增加Claude分支。

External Thread的`thread/start`响应必须保持Desktop客户端分类`source: "vscode"`，并原样反映请求的`ephemeral`与`historyMode`。当前Desktop使用这组三字段选择live timeline；旧实现强制`appServer/true/paginated`时，Host虽然发出了完整Agent Message与Turn终态，Desktop仍丢弃可见文本和后续轮次。该兼容元数据不等于Mapping Store或跨重启持久化已经实现。

Host默认Agent仍只允许`codex | pi`，Claude开发链路必须来自Renderer transport token；本Change不改变Launcher或公开默认Agent选项。

### 7. Renderer使用显式启用列表而不是新增固定旁路

`RendererAgent`增加`claude-code`已知值，但Agent控件接收enabled-agent列表。默认列表仍为`[codex, pi]`。受控Probe只有读取到预先注入的`__codexhostRendererConfigurationV1.enableClaudeCode === true`时才加入Claude按钮。

版本Adapter用一张Agent到transport Model token的有限表更新同一个optimistic Model atom；Composer状态机、prewarm clear、提交冻结和重访恢复保持一套逻辑。未知/禁用Agent不可选择。

主进程标题策略把所有非Codex Agent视为外部Harness并跳过官方标题调用；Pi保留现有计数，其他外部Harness使用通用计数。它不读取Prompt。

### 8. 验证分成Hermetic、真实SDK和真实Desktop三层

- 普通Vitest使用Fake Claude Transport和Fake HarnessAdapter，不启动Claude。
- 显式Live Adapter测试使用真实用户安装、临时cwd、不要求Tool的固定小Prompt、预算/超时和忽略Capture；默认Tool配置调整后需重新运行该Gate。
- Renderer/Host真实Gate通过显式环境与`--enable-claude-code`启动；用户在真实Desktop选择Claude、提交一个合成Prompt、观察流式回复和Cancel/继续。报告只保存ordinal、Harness、事件计数和结果枚举。

没有真实Desktop证据时只能宣布Host纵向测试通过，不能宣布Codex UI接入完成。

## Risks / Trade-offs

- [Host泛化可能回归Pi Tool/Cancel] -> 先用双Fake Adapter扩展Host测试，再运行全部Pi测试和已有Gate；Projector保持不改。
- [SDK消息类型与运行时漂移] -> 使用开放unknown分支和必要字段守卫，不对导出联合做运行时穷举假设。
- [完整Assistant与partial delta重复] -> Transport维护当前Turn已发布文本并做前缀补齐；不一致失败而非重复UI文本。
- [Claude未安装或认证失效] -> 首Turn acceptance前映射为`notInstalled`或`authenticationRequired`；外部token不回落Codex。
- [Renderer显示Claude但Host未启用] -> 只有同一受控Gate同时设置Host环境和Renderer配置；Host仍对未注册token fail closed。
- [私有Renderer结构随Desktop变化] -> 继续复用现有asset/结构签名和fail-closed策略，不为Claude增加第二套Hook。
- [External Thread元数据进入错误的Desktop timeline] -> 与同一Desktop官方app-server差分`source`、`ephemeral`和`historyMode`，Host测试约束请求值与响应值一致，并用可见文本及同Thread续轮Gate验证。
- [开发Gate被误认为产品支持] -> 默认enabled列表不含Claude，OpenSpec/报告明确非发布，法律与跨平台决策保持阻塞。

## Migration Plan

1. 新增Claude Adapter包及Fake Transport测试，不接Host。
2. 泛化Protocol Core路由和Host注册表，先让现有Pi测试无行为变化，再加入Fake Claude路由测试。
3. 增加显式Host运行时Claude注册和Renderer开发配置，默认关闭。
4. 运行全仓检查、Claude Adapter Live和受控Host真实链路。
5. 请求用户完成真实Desktop Agent选择、文本、Cancel和继续验收，保存脱敏结论。

Rollback删除Claude Adapter注册和开发Renderer配置，并保留注册式Host重构；若注册式重构本身回归Pi，则整体回退到本Change前提交。没有持久化迁移或Native Session删除。

## Open Questions

- 当前真实Desktop build已验证Claude正常文本、Question回答后文本、点击停止后的`interrupted`终态和同Thread续轮；失败Result的更多可见形状仍可在后续专门Gate中扩大覆盖。
- Windows完整Claude进程树和发布依赖不在本Change完成条件内。
