# Kimi Code 与 MiMo Code 原生接入

两个独立插件分别接入原生 Kimi Code 和 MiMo Code。Host 使用公共 HarnessAdapter 契约与共享插件路由；不会把这两种 Agent 当成其他 Harness 的 Model 配置。

## 运行与发行

| Agent / 插件 ID | 源码 | 原生版本与入口 | 命令覆盖 |
| --- | --- | --- | --- |
| Kimi Code / `kimi-code` | `packages/adapters/kimi-code` | 2.0.2，`kimi web --no-open --host 127.0.0.1 --port 0`，REST / WebSocket 协议 v2 | `CODEXHOST_KIMI_COMMAND` |
| MiMo Code / `mimo-code` | `packages/adapters/mimo-code` | 0.1.14、0.1.15，`mimo serve --hostname 127.0.0.1 --port 0`，官方 SDK v2 client | `CODEXHOST_MIMO_COMMAND` |

插件搜索 PATH 及各自的 `~/.kimi-code/bin`、`~/.mimocode/bin` 安装目录。原生 CLI 和 Provider 认证仍由用户在各自 CLI 中配置，插件不代为登录。服务器版本不匹配时明确拒绝，不静默切换协议或 CLI。

MiMo 只接受上述已验证版本；不支持的版本诊断同时显示支持版本和服务实际版本。服务健康检查失败单独报告可重试的 `unavailable`，不误报为版本不支持。

每次打开 Session 都启动独立受管服务，叠加本次 Thread 的环境；inspect 使用短生命周期服务，不发送隐藏 Prompt。服务仅监听 loopback，Kimi 使用原生 bearer token，MiMo 使用本次进程生成的随机 Basic Auth 密码。凭据不进入 Native Ref、Renderer 或诊断。部分启动失败与关闭均回收自有资源。

inspect 的 `ready` 表示本地服务和原生目录/配置就绪，不通过隐藏模型请求验证在线认证、额度或免费路由的可达性。特别是 MiMo 的原生目录可包含无需用户凭据的预配置路由，不能仅凭目录存在断言在线模型已认证。

两个包加入根 TypeScript references 和预装插件清单。`npm run build:typescript` 生成可搬移的 `packages/host-runtime/dist/plugins/<id>/plugin.mjs` 与 Manifest。MiMo 固定使用 `@mimo-ai/sdk@0.1.14` 的 client 入口，不调用仍指向 OpenCode 的 server helper；Bundle 不包含 `@opencode-ai/sdk` 或 server helper 的 `cross-spawn`。Payload 和 npm 发行都包含 MiMo SDK 的 MIT 许可证。

## 会话和能力边界

基础接口包括 create、resume、Turn、取消、原生审批/提问、只读历史与 close。恢复必须保留同一 Native Session 身份和目录；会话不存在、忙碌或身份不匹配时失败，不创建空历史代替恢复。Fork、Rollback、会话导入、原生命令、额度和原生 Subagent Transcript 尚未开放。

Kimi 从原生模型目录和 Session 状态读取 Model、Thinking 与权限，配置写入后按原生状态确认。Kimi 2.0.2 的 REST 新建 Session 不自动应用全局默认 Model；调用方省略 Model 时，Adapter 读取原生 config.default_model、核对模型目录并写入 Session profile，随后回读确认。没有可用默认项时在创建 Session 前返回明确错误，不挑选目录首项；已有空模型 Session 在提交 Prompt 前要求选择模型。权限为 manual、auto、yolo；无人值守完整权限映射为 yolo，冲突的显式权限拒绝。Swarm、Tower 和自主 Goal 会话不作为普通 Thread 接入。

MiMo 支持新建和已有 Thread 的 Model 选择，选择前验证原生 connected Provider 的模型目录；Model Ref 保留 Provider/Model 身份。选择设置后续原生 Prompt 的 `model` 参数，并发布当前配置状态；活动 Turn 保持已提交的 Model，其迟到事件不覆盖后续选择。不修改用户全局配置、不发送隐藏 Prompt。未显式指定时沿用原生默认；目录未给出全局默认项时 UI 要求用户明确选择。恢复优先使用 Host 传入的 Model，否则读取最后一条原生用户消息的 Model；选择尚未发送时只保留在当前 Session 配置中。Thinking 选择仍不开放。权限支持原生默认规则、ask、allow 和 full-access，均仅在创建时选择。普通 allow 保留原生强制确认。委派的 `unattended-full-access` 映射为 full-access：先在独立受管实例启用原生 skip-all 和 auto-approve-delete，并回读两项状态，再创建带 wildcard allow / bash_delete allow 规则的会话；显式弱权限冲突时拒绝。恢复根据原生保存的这组权限规则重新启用实例开关。配置失败关闭实例，不改用户全局配置，也不代答 Question 或残留审批。Thinking 不支持的错误单独报告。接收委派不代表已经验证继续向下委派。

取消回执只表示请求已受理。旧 Turn 获得原生终态前保持忙碌，迟到消息按原生身份归属旧轮；原生连接或取消确认失败时终结活动输出并 fault，不在结果不明时接受新轮。

Kimi 使用主 Agent 的结构化 Transcript 构造稳定 Turn/Item 身份，处理 WebSocket durable 游标、epoch、增量 offset 与快照重同步。MiMo 以持久化用户消息 ID 对齐 Turn，按原生 parentID 关联回答和工具，分页读取完整主 Agent 历史。只读快照不把旧消息再次发布到实时 outputs。工具失败、取消和未知终态保持区分。

## Desktop

Agent Picker、Connections、Sidebar 和生产注入名单包含两种 Agent。创建和恢复使用 `encodeHarnessPluginRoute` / `decodeHarnessPluginRoute`，模型、Thinking、权限和偏好按 Agent 隔离。当前固定 Renderer 名单仍是产品接线边界，没有进行全量动态目录迁移。

这两个插件明确不提供模型选择时，Renderer 允许使用原生默认 Model，权限偏好也可单独保存。Kimi 和 MiMo 当前均提供模型选择；原生目录缺少默认项时显示可用选项，用户明确选择前禁止提交，不擅自取第一个模型。原生不可用时保留已选择的 Agent 并禁止提交；缺失插件不回落到 Codex。已有 Adapter 的空目录阻塞行为保持不变。图标暂用 K/M 字母标识；Manifest 未声明图标时不冒充官方品牌资源。

## 验证范围

合成协议测试、真实 CLI 服务测试、浏览器测试和真实 Provider/Model 测试必须分开报告。独立测试入口位于各插件的 `test/native-smoke.mjs`，使用临时工作目录与原生数据目录，不读取用户凭据、不发送模型 Prompt、不修改用户历史。

受控 Provider 验收另外启动仅监听 loopback 的 OpenAI 兼容响应桩，让真实 CLI 执行 Agent Loop。Kimi 使用 `npm run test:native-provider --workspace=@codexhost/adapter-kimi-code`，MiMo 使用 `node packages/adapters/mimo-code/test/native-loop.mjs`（先运行 `npm run build:typescript`）。这类测试会生成隔离测试历史并在结束时清理，不使用真实用户认证，也不等价于在线模型验收。

浏览器测试 `tests/e2e/renderer-binding-startup.spec.ts` 使用真实浏览器和模拟 Host，覆盖新 Agent 默认模型提交、缺失 CLI 阻塞及既有启动行为；它不代表已经启动本机 Codex Desktop 并跑通真实模型会话。搬移 Loader 与发行检查分别位于 `harness-plugin-loader.test.ts` 和 `tests/release/`。

2026-09-22 在 Windows / Node.js 24.14.0 的本地工程验收结果：

| 层次 | 实际结果 |
| --- | --- |
| 编译与边界 | `npm run typecheck`、`npm run lint`、`npm run build:typescript`、`npm run build:renderer`、修改文件 Prettier 和 `git diff --check` 通过；插件 Bundle 已按最终源码重新生成。 |
| 聚焦回归 | Adapter、Host、Renderer、Desktop Control 共 16 个测试文件，403 项通过。 |
| Loader / 发行 | 5 个测试文件，91 项通过；包括移出仓库后的插件加载、Host 启动、SDK Bundle 依赖和两种发行许可证。4 项既有符号链接用例此前因 Windows `EPERM` 受阻，本轮明确排除；另有 1 项平台条件跳过。未修改或禁用这些用例。 |
| 浏览器 | 本机 Edge 执行 10 项启动用例全部通过；覆盖默认模型、权限选择及保存、无默认项时明确选择、缺失 CLI 阻塞，以及既有 Agent 行为。 |
| Kimi 原生执行 | 真实 CLI 2.0.2 配合 localhost Provider：3 个成功轮、1 个取消轮，流式文本、Write 工具、手动审批、Question、非空历史重开、取消忙碌保护及同 Session/同输出消费者续轮通过。6 次本地请求，清理通过。 |
| MiMo 原生执行 | 真实 CLI 0.1.14 配合 localhost Provider：5 轮历史（含取消轮），工具、现场 cwd/每次 open 的环境、审批、Question、取消后继续、非空恢复与稳定历史通过。8 次本地请求，正常退出并完成清理。 |

上述两套原生执行测试合计 14 次 localhost 请求、0 次外部模型调用。结论是本地工程验收通过，在线 Provider 与真实 Desktop 的全链路验收仍未完成。

2026-09-23 在本机 Windows 对 MiMo CLI 0.1.15 复验：隔离 Profile 的原生服务 smoke 与 localhost Provider 执行测试均通过，覆盖创建、恢复、工具、审批、Question、取消后继续和稳定历史；8 次 localhost 模型请求、0 次外部模型调用。SDK 仍为 0.1.14；测试输出从原生 CLI / 服务读取版本，不再写死版本号。

同日补齐 Model 选择后再次通过 localhost Provider 测试（9 次请求），确认选中的模型实际传给 Provider 且非空历史恢复保留该模型。聚焦测试共 31 项、浏览器显式模型选择测试 2 项通过；发行目录经真实 Loader 检查返回 `ready`、`selectModel: true`。Thinking 选择及在线 Provider 的真实推理仍未验证。

同日补齐委派权限后，MiMo Adapter 的 30 项测试通过；真实 CLI 0.1.15 的隔离执行测试包含无人值守创建、工具执行、删除测试自建临时文件和恢复后的原生开关回读（合计 14 次 localhost 请求，0 次外部模型调用）。普通 ask / Question 路径仍通过。当前 Desktop 进程须重启加载更新后的插件；尚未据此声明在线 Provider 委派全链路已通过。

同日修复 Kimi 委派缺少 Model 的问题：真实 CLI 2.0.2 在省略 Model、指定无人值守策略时应用原生默认配置，并通过 6 次 localhost 请求的生成、工具、取消与恢复测试。两套 Adapter 聚焦测试合计 53 项通过。MiMo 0.1.15 另经 15 次 localhost 请求验证：委派省略 Model 时，既支持显式全局默认，也支持全新隔离 Profile 未配置全局 Model 的原生选择路径；均无外部模型调用。

真实 Provider 下的两轮工具调用、取消后继续、审批/提问、非空历史恢复与工具现场环境仍需单独验收。macOS、Linux、SSH、Remote Control 和完整跨 Harness 委派不作为当前 Windows 本地检查已通过的能力。

协议选择及先前探测证据见[接入规划](../proposals/kimi-mimo-harness-integration.md)。
