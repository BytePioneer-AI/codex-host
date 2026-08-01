## Context

当前 `ClaudeCodeAdapter.inspect()` 只解析用户安装的 executable，返回空 Model Catalog、`selectModel=false` 和 `selectThinkingOption=false`；create input携带Model也会被拒绝。Pi已经通过通用Harness Catalog、opaque Ref、request-local carrier、Idle command和有序Session state实现Model控制，但其原生身份与RPC不能进入Claude实现。

官方`@anthropic-ai/claude-agent-sdk@0.3.220`的初始化响应提供`ModelInfo.value/displayName/description/resolvedModel/supportsEffort/supportedEffortLevels`，`Query.setModel()`提供Session级写入，稳定`Query.getContextUsage()`响应包含当前实际`model`。受控无Prompt探测已确认：当前用户配置可把`default/opus/sonnet/haiku`等selectable alias解析到同一个第三方实际Model；初始化、readback、setter和reset均不创建可恢复Native Session，拥有的Claude进程可有界退出。该证据也说明Paseo式静态manifest或直接读取`settings.json`会把理论Claude模型误报为当前可用模型。

本Change跨越Shared Contracts、HarnessAdapter、Claude Adapter、Protocol Core、Host和Renderer。现有Claude生产Session保持lazy；Host composition启动后若Claude Code可用，会后台启动一次无Prompt临时Query预取Catalog，用户主动inspection复用同cwd cache/in-flight；普通create/resume仍不得为未使用Thread启动长期Claude Session。

## Goals / Non-Goals

**Goals:**

- 只从用户安装的Claude Code和官方SDK读取codexhost当前运行配置实际暴露的selectable Model Catalog。
- 保留动态alias/default的可重放选择身份，同时发布SDK稳定操作回读的实际Model显示值。
- 将Claude draft Model绑定到精确Composer create，并允许已启动Idle Session通过通用`model.select`切换。
- 复用通用Host inspection、Model command、state revision和Renderer Model picker，不增加Claude SDK到Host/Renderer。
- 保持无Prompt inspection无Native Session、无模型请求、无用户配置写入，并有界关闭进程。

**Non-Goals:**

- 不读取或修改`~/.claude/settings.json`，不复制Claude配置优先级、managed policy、Provider映射或静态模型manifest。
- 不保证Catalog中的每个条目一定可完成远端Turn；认证、路由和`model_not_found`仍由真实Turn报告。
- 不在本Change开放Claude Thinking选择、fast mode、context suffix选择或effort实际状态推断。
- 不把Provider、base URL、价格、账户、凭据、原始SDK payload或绝对路径暴露到公共Catalog。
- 不改变Pi、官方Codex、Mapping Store格式、Claude历史/Fork范围或executable分发策略。

## Decisions

### 1. 官方SDK初始化结果是唯一Catalog权威

Claude inspection使用与生产Claude Session相同的用户executable、environment、setting sources和cwd启动临时streaming Query，等待`initializationResult()`，严格消费`models`，再调用稳定`getContextUsage()`读取当前实际Model。`supportedModels()`只是同一初始化快照的便捷入口，不再并行读取配置文件。

Catalog normalization只接受非空有界`value/displayName`和shape合法的可选能力字段；`description`不作为身份或能力解析来源。`supportedEffortLevels`只执行通用非空、长度和transport-safe shape校验，不维护Claude effort语义白名单；运行时返回的合法ID原样保留并按Model关联。未知字段、账户、Provider配置和完整context payload在Claude Adapter第一次正式消费时丢弃。无可用Model、重复冲突、malformed readback或启动失败返回显式normalized error。

替代方案：Paseo式hardcoded manifest加settings补充。拒绝，因为第三方gateway会继续显示不可调用的Claude模型，且无法表达managed policy和动态alias解析。

替代方案：只解析`settings.json`。拒绝，因为会复制Claude Code的配置级联并遗漏环境、项目、local、managed和未来设置语义。

### 2. selectable Ref与runtime-resolved Model分离

`HarnessModelRef`继续是Adapter-owned可重放选择身份。Claude Adapter将SDK `ModelInfo.value`编码成canonical、transport-safe的`claude-model-v1.<base64url>`；只有Claude Adapter解码。`default`使用固定Adapter sentinel并在create时省略`options.model`、在Idle reset时调用`setModel(undefined)`，因此始终跟随Claude Code当前默认策略。

公共Model entry和Session/Thread选择状态增加可选、非空、有界`resolvedModelLabel`。它只用于显示SDK `resolvedModel`或稳定`getContextUsage().model`观察，不是Ref、route、Provider或setter输入。`effectiveModel`继续表示当前已接受的selectable Ref；动态alias解析成不同实际Model是合法状态：

```text
effectiveModel       = ref("sonnet")
resolvedModelLabel   = "当前实际底层模型"
```

同一SDK `value`只能产生一个Ref；不同alias即使当前解析到相同实际Model也保留为不同selectable identity。重复显示名由Adapter使用alias value构造可区分label，不解析description文本。

替代方案：用实际Model字符串替换`effectiveModel`。拒绝，因为`default`/alias语义会丢失，回读字符串也未必是可重放setter值。

### 3. Inspection拥有临时Query、启动预取、缓存和严格清理

Host composition创建Adapters后立即以fire-and-forget方式调用一次Claude inspection。该调用不等待Catalog，不阻塞Mapping Store、官方Codex app-server或Renderer启动；Claude未安装、认证不可用或inspection失败只产生未缓存的normalized结果，不影响Codex/Pi。用户随后打开Claude Model控件时，复用相同默认cwd的in-flight或成功缓存。

每个cold cwd inspection创建一个临时Query和受监督子进程，不提交User Message、不开始Turn、不调用模型endpoint。成功或失败都按Session close同级边界关闭Query和进程，并确认没有持久Native Session。结果按normalized cwd在Adapter进程内缓存；同cwd并发请求共享in-flight；`refresh:true`重建并原子替换成功缓存；失败不缓存。Adapter close清除缓存并等待所有inspection清理，包括仍在运行的启动预取。

Inspection返回`selectModel=true`仅当目录、默认Ref、实际Model readback和setter能力结构均可用。Thinking Catalog可根据ModelInfo保留shape合法的runtime effort ID供诊断/未来能力使用，以原始ID作为当前显示label，并按每个Model的`supportedThinkingOptionIds`保持不同能力集合；它不维护固定ID或label映射。`selectThinkingOption=false`且Renderer不得开放Claude Thinking控件。

### 4. Lazy create在首Turn前应用并回读Model

`open(create)`只保存可选Claude Model Ref，不启动Query。首个`turn.start`在接受生命周期前启动长期Query：default sentinel省略`options.model`，其他Ref解码为原始SDK value并传给`options.model`。初始化后调用稳定`getContextUsage()`，发布包含Native Ref、selected Ref和`resolvedModelLabel`的完整`session.state.changed`，然后才发布`turn.started`。

如果指定value不在当前可用Catalog、初始化拒绝或实际Model不可读，首Turn在接受前失败且不得发布虚假Model状态。Catalog变化导致的真实native rejection保持显式错误，不回退default或Codex。

Resume不从持久Catalog推断Model。长期Query启动后以Claude native Session和readback为准恢复state；本Change不改变Mapping Store格式。

### 5. Idle Model选择由setter加稳定readback确认

已启动Session在open、Idle且无history/configuration操作时接受`model.select`。Claude transport调用`setModel(decodedValue)`，随后调用稳定`getContextUsage()`；只有两步均成功并返回有效实际Model，Adapter才先发布完整state再返回`{completed:true}`。

动态alias不要求实际字符串等于SDK value；successful setter加有效readback证明当前可确定状态。setter明确拒绝时保留先前state。setter可能成功但readback失败时，实际写入结果不确定，Session fault并拒绝后续Turn/写入。配置命令与Turn保持同一互斥临界区。

Thinking setter不在范围内，因为当前SDK没有与Model readback同等级的稳定Session effort读取；不得从请求、ModelInfo、Hook或描述推断实际effort。

### 6. Claude使用有限的request-local transport carrier

Protocol Core增加：

```text
codexhost/claude-code-native
codexhost/claude-code-native@<opaque-claude-model-ref>
```

Ref字符集不含`@`，carrier有界且可无歧义解析。Protocol Core只确认Harness ownership和opaque Ref，不解码Claude value。Host将create Ref传给`Adapter.open(create)`；现有Thread carrier由`decodeExternalTransportSelection(harnessId, value)`验证，foreign carrier继续fail closed。

不引入Thinking component、通用Harness carrier parser或process-level nextModel。Pi格式和官方Codex Model透明路径不变。

### 7. Renderer Model UI按external Harness capability驱动

Renderer把当前`PiModelControlView`、client方法名和Composer字段泛化为external Harness Model state，但不改变控件视觉和fixed Host methods。选择Claude时调用同一个`codexhost/harness/inspect`，显示normalized labels；`resolvedModelLabel`与选择label不同时作为紧凑当前实际Model信息，不显示transport token或raw Ref。

Draft选择同步更新该Composer的Claude carrier并清理stale official prewarm；提交冻结最终Agent+Model。Existing Claude Thread使用固定Thread inspect和Model select，等待Host有序state后更新。Agent切换、Composer replacement、target变化、refresh和dispose继续通过generation丢弃迟到结果。Codex保持原生Model control，Pi行为保持原样。

### 8. 版本能力以结构化Gate判断，不按字符串猜测

当前SDK manifest声明配套Claude Code `2.1.220`，受控本机旧版`2.1.133`仍返回目录和readback，但缺少部分较新可选字段。实现严格feature-detect所需字段；缺少目录/readback/setter时保持Claude Harness ready但Model selection capability false，不按CLI版本号伪造能力。

Hermetic tests使用Fake Claude transport和合成ModelInfo。显式inspect Gate验证无Prompt目录、default/alias/custom模型shape、readback、无Session和进程退出；显式live Gate在用户同意quota后验证至少两个真正不同且可调用Model的切换，若当前环境只有alias映射到同一底层Model则报告BLOCKED而不是PASS。Desktop Gate验证Claude draft/create、Existing Thread、Codex/Pi隔离和隐私。

## Risks / Trade-offs

- [Catalog是Claude Code配置快照，不是远端callability证明] → selection只证明结构状态；真实Turn错误保持显式且不回退。
- [多个alias解析到同一实际Model，UI看似重复] → 保留可重放alias身份并用value区分label，同时显示resolved Model；不错误去重不同控制语义。
- [default在不同时间解析到不同Model] → Ref保持default策略，实际值每次从稳定readback刷新，不持久化静态映射。
- [旧CLI缺少`resolvedModel`或能力字段] → 以`getContextUsage().model`补充当前实际值；缺少必需操作则降级为空/不可选，不解析description。
- [启动预取会在用户未选择Claude时启动Claude hooks/plugins] → 预取保持非阻塞、无Prompt、最小setting sources/tools和完整资源所有权；若该自动行为在受支持版本产生不可接受副作用，应撤回startup prefetch而不是读取静态配置。
- [Windows临时cwd在进程退出前被占用] → inspection拥有子进程并等待有界退出后才完成，不在Query close刚返回时提前清理。
- [resolved Model名称可能包含用户自定义标识] → 仅作为用户主动打开Model控件时的有界显示数据，不记录到日志、Gate或持久Store。

## Migration Plan

1. 扩展Shared Contracts和Fake Harness state，先定义selectable/ref与resolved display语义。
2. 为Claude私有transport增加Catalog inspection、Model setter和稳定Model readback，并完成Hermetic normalization/cleanup测试。
3. 在Claude Session实现lazy create Model、Idle selection、state ordering和failure/fault边界。
4. 扩展Protocol carrier和通用Host create/Existing Thread控制测试。
5. 泛化Renderer client/state/picker并保留Pi与Codex回归。
6. 运行focused tests、`npm run check`、`npm run build`、strict OpenSpec validation和diff检查。
7. 执行显式Claude no-Prompt Gate、双实际Model live Gate和受支持Desktop Gate；未满足环境条件的场景记录BLOCKED。

Rollback移除Claude selected carrier、Catalog/selection capability和Renderer Claude Model state，恢复generic `codexhost/claude-code-native`。公共新增字段为optional，不要求Mapping Store迁移；Pi和既有Claude Thread继续兼容。

## Open Questions

- `resolvedModelLabel`是否需要在后续持久化用于离线Thread列表，还是保持当前加载Session观察；本Change选择后者。
- 官方SDK未来若增加稳定effort readback，应另建Change开放Claude Thinking，而不是复用本Change的Model成功条件。
- 对只返回alias、不返回具体custom row的Claude Code版本，UI应保留所有alias还是只突出default；本Change优先忠实保留所有distinct selectable value。
