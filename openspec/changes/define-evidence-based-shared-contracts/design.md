## Context

当前 `packages/shared-contracts` 只导出 Workspace Contract Version 和 package metadata，尚未提供正式 Host ID、Envelope、Native Ref 或错误 Schema。后续 Gate B、HarnessAdapter、Mapping Store、Protocol Core 和 Renderer Bridge 都需要跨 package、跨进程或跨浏览器/Node 边界传递这些值；如果各自定义临时类型，身份、序列化和错误语义会在正式垂直链路前分叉。

Gate A 已观察到 Codex app-server 使用 LF JSONL 承载 JSON-RPC-like 消息：Request 具有 `id`、`method`和可选 `params`，Notification 没有 `id`，Response 使用同一 `id`并携带 `result`或 `error`，当前消息不要求 `jsonrpc: "2.0"`。架构同时要求透明消息尽量保留原始 JSONL 和未知字段。

Gate C 已证明 Pi Native Session 身份、成功/取消 Turn 的稳定原生身份候选以及 Fork/Clone Checkpoint 语义成立，但 Pi 的 Entry ID、Session locator 和命令形状仍属于 PiAdapter。Shared Contracts 只能表达 versioned opaque ref，不能泄漏 Pi RPC 类型或把原生 ID当作 Host ID。

本变更影响一个被 Renderer 和多个 Node package 共同依赖的公共 package，因此类型必须同时具备 TypeScript 品牌隔离、Zod Runtime 校验、JSON 可序列化约束和浏览器安全性。

## Goals / Non-Goals

**Goals:**

- 建立第一批有 Gate A/C 证据和正式设计依据的生产 Runtime Contracts。
- 统一 JSON 值、Harness/Host ID、JSON-RPC Envelope、Native Ref 和跨边界错误的类型与 Schema。
- 保证 Envelope 校验不要求当前 Codex 未发送的字段，也不丢失透明转发需要的未知字段。
- 保证 Native Ref 可持久化、可比较、版本化且对非所属 Adapter 保持 opaque。
- 让 `shared-contracts` 通过自动门禁保持 Browser-safe。
- 让后续 package 只通过 `@codexhost/shared-contracts` 公共导出消费契约。

**Non-Goals:**

- 不定义 `CreateThreadIntent`、Bridge Contract 或 Gate B 的 Renderer Method。
- 不定义完整 HarnessAdapter、HarnessSession、Host Operation/Event/Interaction 或 Snapshot。
- 不定义 Mapping Store Record、索引 Key、迁移或原子写入 Schema。
- 不定义 Pi RPC Command/Event、Pi Session 文件或 Codex Method 专属参数。
- 不实现 JSONL Framer、JSON-RPC Peer、Request Router、ID Generator 或业务错误映射。
- 不声明失败 Agent Run、Retry、自动 Compaction 或未验证 Catalog 的 Pi 语义。

## Decisions

### 1. Shared Contracts 只拥有跨边界稳定值，不拥有业务行为

`packages/shared-contracts/src` 按 `json-value.ts`、`ids.ts`、`json-rpc.ts`、`native-refs.ts`和 `errors.ts` 分责，并由根 `index.ts` 统一导出。类型优先从对应 Zod Schema 使用 `z.infer` 推导，避免手写 Interface 与 Runtime Schema 漂移。

本变更不新增 package subpath export；现有 `.` 和 `./version` 足够。`./version`继续允许 Renderer 在只需要版本协商时避免导入全部 Schema。新增导出是 additive change，`WORKSPACE_CONTRACT_VERSION`保持 `1`；该常量的兼容和升级策略留给第一次真实跨进程版本协商 change。

替代方案是在每个调用 package 内定义类型。该方案会允许同名 ID、Native Ref 和错误结构产生多个事实源，因此拒绝。

### 2. JSON 值使用递归 Runtime Schema 限制为真实可序列化数据

公共层定义 `JsonPrimitive`、`JsonArray`、`JsonObject`和 `JsonValue`。Runtime Schema 接受 `string | finite number | boolean | null`、递归数组和字符串键对象，拒绝 `undefined`、`bigint`、函数、Symbol、非有限数字和其他非 JSON 值。

`NativeSessionRef.locator`、`NativeCheckpointRef.locator`、Envelope `params/result/error.data`只使用 `JsonValue`，不使用无限制 `unknown`。这保证经 Bridge 或 Mapping Store 传输前可以证明结构可序列化，但不代表 Schema 能判断某个字符串是否是 Secret。

替代方案是直接使用 `unknown`或 `Record<string, unknown>`。前者无法保护持久化边界，后者不能表达数组和递归值，因此拒绝。

### 3. ID 使用不改变原值的 Zod 品牌

公共层定义：

```text
HarnessId
HostThreadId
HostTurnId
HostItemId
HostInteractionId
```

每个 Schema 接受非空且非纯空白字符串，但不执行 trim、大小写转换、UUID 校验或前缀校验。品牌只存在于 TypeScript 类型系统，序列化值仍为原始字符串。`HarnessId`是 Native Ref 的归属字段；四类 Host ID 不能相互赋值，也不能由 Adapter 原生 ID 隐式赋值。

本变更不增加 `CreateRequestId`，因为其与首次发送的最终关联边界属于 Gate B。也不提供随机 ID 生成器，ID 分配所有权仍由后续 Protocol Facade/Adapter 实现决定。

替代方案是规定 UUID 或品牌前缀。当前证据没有要求具体编码格式，提前限制会把实现选择伪装成协议事实，因此拒绝。

### 4. Envelope 表达当前 app-server 方言，而不是强制标准 JSON-RPC 2.0

公共层定义 `JsonRpcId`、Request、Notification、Success Response、Error Response 和它们的联合 Schema：

- Request 必须有 `id`和非空 `method`；Notification 必须没有 `id`；
- `JsonRpcId`接受 string 或 integer，不接受 `null`；
- `params`可选且必须是 `JsonValue`；
- Success Response 必须有 `id`和 `result`，且不得有 `error`；
- Error Response 必须有 `id`和 `{ code: integer, message: string, data?: JsonValue }`，且不得有 `result`；
- `jsonrpc`可缺省；存在时必须为 `"2.0"`；
- 已知的互斥字段使用 `never`约束，防止 Request/Notification/Response 误分类；
- 顶层 Envelope 和 Error 对象保留未知字段，不使用 Zod 默认 strip 行为。

同一 Request Schema 同时用于 Desktop Request 和 Server Request；方向和 Pending Request 所有者由后续 JSON-RPC Peer 管理，不复制两套 Envelope。

Schema 只验证 Envelope，不验证 `thread/start`等 Method 的 params/result。Protocol Core 对透明消息仍可保留原始 JSONL 行；Schema parse 结果用于需要分类或跨边界重建的路径。

替代方案是要求 `jsonrpc: "2.0"`。这会拒绝 Gate A 已评审 Fixture，因此拒绝。另一个替代方案是把所有消息定义为一个大量 optional 字段的对象；该方案无法保证 result/error 互斥，因此拒绝。

### 5. Native Ref 使用严格、版本化、opaque 的 V1 结构

公共结构与 HarnessAdapter 正式设计保持一致：

```text
NativeSessionRefV1
- harnessId
- nativeSessionId
- locator?
- formatVersion: 1

NativeTurnRefV1
- harnessId
- nativeSessionId
- nativeTurnKey
- formatVersion: 1

NativeCheckpointRefV1
- harnessId
- nativeSessionId
- checkpointId
- locator?
- formatVersion: 1
```

ID/Key 必须非空且非纯空白。V1 顶层对象使用 strict Schema；相同 formatVersion 下出现未评审字段视为无效，未来字段通过新的 formatVersion 和判别联合引入。`locator`内部允许任意 `JsonValue`，但 Protocol Core 和 Mapping Store 只能保存、比较和回传，不能解释。

Native Turn Ref 与 Native Checkpoint Ref 即使使用同一个底层 Pi Entry ID也保持独立类型，因为稳定身份不等于可 Fork。公共 Schema 不提供 `JSON.stringify()` Key helper；规范 Key 编码由 Mapping Store change 根据实际索引需求定义。

Producer 不得把 Transcript、Prompt、Tool 输出、Token、API Key 或 OAuth Secret写入 Ref。该语义不能仅靠通用 Schema识别，后续 Adapter 契约测试和安全审计仍需负责。

替代方案是把 Pi Entry ID或 Session 文件路径做成公共字段。该方案泄漏具体 Harness 格式并阻塞后续 Adapter 演进，因此拒绝。

### 6. 统一错误只固定跨边界结构，不提前固定领域错误码

公共层定义最小错误结构：

```text
CodexhostError
- code: non-empty string
- message: non-empty string
- retryable: boolean
- diagnostic?: non-empty string
```

Runtime Schema 使用 strict object。`code`暂不定义全局 enum；HarnessAdapter、Mapping Store、Bridge 和 Protocol Core 在各自 change 中用领域 Schema 收窄 code，并在跨边界前投影到这一结构。这样保留一致的 UI/日志字段，又不把尚未完整实现的 HarnessError 或 Store Error 枚举提前放进 Shared Contracts。

`message`面向用户，`diagnostic`面向受限诊断；两者都不得包含凭据、Secret、不必要的 Prompt 正文或完整 Native locator。Schema 只能校验结构，脱敏由错误生产者和日志边界负责。

替代方案是现在复制完整 `HarnessError.code`联合。该联合属于后续 HarnessAdapter V1，而且不能覆盖 Mapping Store/Bridge 错误，因此拒绝。

### 7. Browser-safe 属性进入自动边界门禁

`tools/check-boundaries.mjs`扩展 package ownership 规则，对 `packages/shared-contracts`应用与 Renderer 相容的禁止导入集合：Node.js built-in、Electron 私有 API、已知 Harness SDK，以及匹配 Pi Harness SDK 的 package。`zod`是允许的浏览器安全依赖。

测试同时覆盖合法 Zod/相对模块导入和每类非法依赖。现有 Renderer 与跨 package 源码导入规则保持不变。普通 `npm run check`必须执行该门禁，不依赖真实 Codex Desktop 或 Pi。

只依赖代码评审无法持续保护这一基础包，因此不采用纯文档约束。

### 8. 测试以公共行为和已评审证据为中心

测试分为：

- Runtime Schema 正反例；
- TypeScript 品牌不可互换的编译期断言；
- Gate A Fixture 中 Request/Notification/Response shape 的逐项解析；
- parse 后未知字段保留和 JSON round-trip；
- Native Ref formatVersion、strict shape 和 JSON-safe locator；
- 根 package 公共导出；
- Shared Contracts Browser boundary 正反例。

测试不得读取 `.codexhost/gate-c/`、用户 Pi Session、本机配置或网络。Gate C 证据只用于确定 Native Ref 语义和测试样例，不把真实 Pi locator 或 Entry ID提交为 Fixture。

## Risks / Trade-offs

- [Envelope Schema 保持未知字段会接受尚未理解的扩展] → 只把它用于结构分类；Method 专属处理必须在 owning package 使用更窄 Schema，透明路径继续保留原始行。
- [string 类型的通用错误码不如 enum 严格] → 各领域 change 必须扩展基础 Schema 并收窄 code；本变更只避免提前猜测跨领域全集。
- [Schema 无法识别 locator 或 diagnostic 中的 Secret] → 明确 producer 责任，后续 Adapter/日志测试增加脱敏和禁止内容检查。
- [品牌在 JavaScript Runtime 中消失] → 所有不可信边界必须调用 Zod Schema，不能依赖 TypeScript 品牌作为安全校验。
- [严格 Native Ref V1 会拒绝同版本新增字段] → 新字段必须通过 formatVersion 迁移，避免持久化格式静默漂移。
- [递归 JSON Schema 可能在恶意极深输入上消耗栈] → 本变更不引入网络监听；后续 Bridge/Protocol 边界根据实测增加 Frame/深度限制，不在无证据时猜测阈值。

## Migration Plan

1. 以 additive exports 增加基础模块和测试，保持现有 package metadata/version 导出不变。
2. 扩展边界门禁并确认现有 Workspace 没有新增违规。
3. 使用已提交 Gate A Fixture 验证 Envelope；Gate C 本地证据保持忽略且不被读取。
4. 运行 `npm run check`、`npm run build`和严格 OpenSpec 校验。
5. 后续 Gate B、HarnessAdapter 和 Mapping Store change 逐步采用公共类型；本变更不迁移持久化数据。

若实现需要回滚，删除新增 additive exports、测试和边界规则即可；当前没有生产调用方或用户数据需要迁移。

## Open Questions

本变更没有阻塞实现的未决问题。`CreateRequestId`、Envelope `null` ID处理、领域错误码联合、Native Ref规范索引 Key和 Contract Version协商均明确推迟到出现对应真实调用方或 Gate 证据的后续 change。
