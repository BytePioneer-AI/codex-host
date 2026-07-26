## 1. 证据与公共模块边界

- [x] 1.1 复核已提交 Gate A app-server Fixture、Gate C 结论文档和 HarnessAdapter/持久化设计，只记录本变更采用的 Envelope、ID、Native Ref 和错误结构事实，不读取 `.codexhost/gate-c/`或用户本地数据
- [x] 1.2 在 `packages/shared-contracts/src/`建立 `json-value.ts`、`ids.ts`、`json-rpc.ts`、`native-refs.ts`和 `errors.ts`职责边界，并通过根 `index.ts`提供 additive 公共导出
- [x] 1.3 保持现有 `WORKSPACE_CONTRACT_VERSION`和 `./version`导出不变，确认本变更未增加 package subpath、Runtime dependency或其他内部 package 依赖

## 2. JSON 值与品牌标识符

- [x] 2.1 实现递归 `JsonPrimitive`、`JsonArray`、`JsonObject`、`JsonValue`类型和 Zod Schema，接受可 round-trip JSON并拒绝 undefined、bigint、函数、Symbol及非有限数字
- [x] 2.2 实现 `HarnessId`、`HostThreadId`、`HostTurnId`、`HostItemId`和 `HostInteractionId`品牌 Schema，拒绝空白值且不改变原始字符串或假设 UUID/前缀格式
- [x] 2.3 增加 JSON Runtime 正反例、嵌套 round-trip、标识符 Runtime 负例和 TypeScript 品牌不可互换测试
- [x] 2.4 拒绝循环 object、array 和 Native Ref locator且不从 `safeParse()`抛出异常，同时允许非循环共享引用

## 3. JSON-RPC Envelope

- [x] 3.1 实现接受 string/integer 的 `JsonRpcId`以及 JSON-RPC Error 对象 Schema，允许缺省 `jsonrpc`且在该字段存在时只接受 `"2.0"`
- [x] 3.2 实现 Request、Notification、Success Response、Error Response及联合 Schema，约束 id/method/result/error互斥并保留顶层和 Error 未知字段
- [x] 3.3 用已评审 Gate A `official-app-server.fixture.json`逐项验证无 `jsonrpc`的 Request、Notification、成功 Response和错误 Response
- [x] 3.4 增加 string/integer ID、Server/Desktop 共用 Request、未知 Method、未知字段保留和 JSON round-trip测试
- [x] 3.5 增加 result/error并存、Notification带 id、Response带 method、null ID和畸形 Error等校验失败测试
- [x] 3.6 保留并使用 `JsonValue`校验顶层 Envelope和Error未知扩展字段，拒绝不可序列化及循环扩展值
- [x] 3.7 区分字段缺省与显式 `undefined`，使Envelope互斥字段、JSON可选字段、Native Ref locator和错误diagnostic在Runtime及命名类型中保持精确

## 4. Native Ref 与跨边界错误

- [x] 4.1 实现 strict `NativeSessionRef`、`NativeTurnRef`和 `NativeCheckpointRef` V1 Schema，包含 Harness/Session归属、专属 Key、可选 JSON locator和 `formatVersion: 1`
- [x] 4.2 增加三类 Ref 正反例，覆盖 opaque locator、Turn/Checkpoint类型隔离、未知版本、空白身份、V1 未声明顶层字段和不可序列化 locator
- [x] 4.3 实现 strict `CodexhostError`基础 Schema，固定 code、message、retryable和可选 diagnostic结构，但不加入 HarnessAdapter、Mapping Store、Bridge或 Protocol Core领域 code enum
- [x] 4.4 增加错误结构正反例和领域 Schema 可在不修改公共结构的前提下收窄 code 的测试
- [x] 4.5 审计 Native Ref和错误 Fixture不包含 Transcript、Prompt、Tool输出、Diff、凭据、完整本地 locator或其他真实用户数据

## 5. Browser-safe 与 Workspace 门禁

- [x] 5.1 扩展 `tools/check-boundaries.mjs`，禁止 `shared-contracts`导入 Node.js built-in、Electron私有 API、Harness SDK和其他内部 package，同时保留现有 Renderer与跨 package源码规则
- [x] 5.2 扩展边界检查测试，覆盖 Shared Contracts 合法 Zod/相对导入，以及 Node、Electron、Harness SDK和内部 package违规 import
- [x] 5.3 增加代表性 Shared Contracts 根导出的 Browser Target bundle smoke test，确认公共 Runtime Schema可由浏览器构建消费且不修改 Renderer产品代码

## 6. 文档与质量收敛

- [x] 6.1 更新受影响的开发状态和契约文档，使实际公共导出、错误边界、Envelope方言、Native Ref格式和未实现范围一致
- [x] 6.2 运行 Shared Contracts、边界门禁和 Browser bundle的最窄相关测试，确认普通测试不启动或读取真实 Codex Desktop、Pi、网络、认证或本地 Gate C证据
- [x] 6.3 运行 `npm run check`、`npm run build`和独立 `npm run test:e2e`，记录所有实际结果
- [x] 6.4 审计公共导出未包含 `CreateThreadIntent`、完整 Bridge、Host Operation/Event/Interaction、Mapping Store Record、Pi RPC或 Codex Method专属 Schema
- [x] 6.5 运行 `openspec validate define-evidence-based-shared-contracts --strict`并确认 proposal、design、spec、tasks及实现行为一致
- [x] 6.6 审计 Git 状态，确认没有本地 Gate C Capture、用户 Session、配置、日志、构建输出或其他忽略数据进入版本控制

## 7. 实际验证结果

- Shared Contracts、边界门禁和Browser bundle最窄测试：`8`个测试文件、`83`个用例通过；生产TypeScript构建、测试类型检查和真实仓库边界扫描通过。
- `npm run check`：通过；Prettier、ESLint、边界检查、TypeScript、`30`个Vitest文件共`147`个用例、Rust fmt、Clippy和Rust测试全部成功。
- `npm run build`：通过；TypeScript、Renderer Browser Bundle和三个生产Rust package构建成功。
- `npm run test:e2e`：通过；Playwright `1/1`用例成功，未启动真实Codex Desktop或Pi。
- `openspec validate define-evidence-based-shared-contracts --strict`：通过。
