## 1. 收口旧调查与协议事实

- [x] 1.1 归档未完成的 `verify-renderer-thread-intent-binding`，保存 carrier可达、prewarm语义、Shim参数识别和失败结论，不提升其 delta spec
- [x] 1.2 对当前官方 CLI执行隐私受限探测，记录 `model/list`、`thread/start`、`turn/start`和文本事件的 Method、字段名、类型、方向与关联，不保存正文或真实 ID
- [x] 1.3 真实验证追加 Model和临时 native Catalog均不能让当前 Desktop picker显示 Pi，记录 `BLOCKED`且不回退 private Renderer seam

## 2. 正式 Host Runtime入口与透明代理

- [x] 2.1 让 Shim解析 Codex全局参数后的 `app-server`子命令，只在显式正式 Host配置下启动 Host Runtime，非 app-server和普通官方 CLI保持透明
- [x] 2.2 在 `packages/host-runtime`组合官方 app-server、Protocol Core和 Pi Adapter，使用正式环境变量与配置，不依赖 `tools/gate-b`或 `CODEXHOST_GATE_B_*`
- [x] 2.3 在 `packages/protocol-core`实现严格 LF JSONL、背压和默认原始 frame转发；日志不得污染 stdout或包含正文
- [x] 2.4 实现官方 app-server退出、Host关闭和部分启动失败的有界清理

## 3. 技术 PoC Agent选择与 Thread路由

- [x] 3.1 Launcher提供显式 `--agent codex|pi`，只通过本次受控 Desktop进程环境传递，不修改用户或全局配置
- [x] 3.2 将内部 `codexhost/pi-native`只解码为 `{ harnessId: "pi", routeMode: "native" }`，不把 Pi实际 Model、Provider、Account或 Billing Source写成该 ID
- [x] 3.3 `--agent pi`时在接收真实 `thread/start`的同一处理步骤中建立 Pi绑定，不使用一次性 `nextHarness`、发送后 join或 private Renderer seam
- [x] 3.4 对 Pi创建分配 Host Thread ID、建立进程内 Thread归属并启动 Pi Native Session，不转发官方创建或创建影子 Thread
- [x] 3.5 `--agent codex`和非接管消息保持官方 app-server行为；后续路由只按 Thread归属
- [x] 3.6 根据真实协议结构实现当前 Desktop所需的最小创建 Response/Event，并对创建失败关闭部分资源且返回明确错误

## 4. Pi文本垂直链路

- [x] 4.1 在 `packages/adapters/pi`实现正式最小 Pi RPC Session和文本 Turn interface，复用 Gate C事实但不依赖 Gate-only模块
- [x] 4.2 将 Pi Thread的 `turn/start`文本发送给真实 `pi --mode rpc`，确认 Agent Loop由 Pi执行且不进入官方 Codex
- [x] 4.3 将 Pi文本增量、完成和明确错误投影为当前 Codex UI实际需要的最小 app-server事件，不伪造 Tool、Approval或 Diff
- [x] 4.4 同一 Pi Thread第二个 Turn继续进入相同 Native Session；不同 Thread不共享可变 Session状态
- [x] 4.5 Desktop/Host正常关闭时有界停止 Pi Session；失败和 EOF不留下本次 Pi孤儿进程

## 5. 验证与收口

- [x] 5.1 增加最小公开行为测试：全局参数后的 app-server识别、transport model解码和官方透明代理回归
- [x] 5.2 以正式 Host Runtime smoke验证 `--agent pi`可创建 Pi Thread并完成真实文本 Turn和事件投影
- [x] 5.3 在真实 Codex UI验证 `--agent pi`首轮和同 Thread多轮文本均由 Pi执行，且多轮期间不新增 Pi RPC Session
- [x] 5.4 验证关闭后没有本次 Desktop、Shim、Host、官方 app-server或 Pi孤儿进程，Launcher正常退出且 stderr为空
- [x] 5.5 运行 `npm run check`、`npm run build`、`cargo test --workspace --locked`、strict OpenSpec validation和 `git diff --check`
- [ ] 5.6 PoC通过后新建页面内独立 Agent选择器和持久化 change；不得把 Launcher选择声明为公开 MVP最终 UI
