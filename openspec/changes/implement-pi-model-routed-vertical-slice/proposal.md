## Why

`verify-renderer-thread-intent-binding` 已证明 Renderer 扩展字段能够到达 app-server Observer，但当前可取得的 `thread-prewarm-start` seam 属于预热而不是最终发送，并存在 CDP wrapper 安装竞态和私有 bundle 版本敏感性。继续扩建该 Gate 不能直接形成用户可用的 Pi 对话。

真实 Desktop验证又证明：即使 Protocol Facade增强 `model/list`，并让官方 app-server加载包含完整 Pi条目的临时 `model_catalog_json`，当前 Codex Desktop原生 Model选择器仍只展示官方 Model。该 seam在当前版本明确 `BLOCKED`，不得继续猜测 Catalog字段或回退 private Renderer seam。

当前应通过 Launcher显式选择本次受控 Desktop使用的 Agent，在正式 app-server Protocol Facade中将新 `thread/start`原子绑定为内部 Pi transport model，并完成最小 Pi垂直链路。该入口属于技术 PoC；公开 MVP仍需页面内独立 Agent选择器。

## What Changes

- 归档未完成的 `verify-renderer-thread-intent-binding` 调查；不将其 delta spec 提升为主 spec，也不声称 Gate B `PASS`。
- 让 Shim 在解析 Codex全局参数后识别 `app-server`子命令，并只在显式 codexhost启动配置下进入正式 Host Runtime；普通官方 CLI继续透明。
- Launcher提供显式进程级 `--agent codex|pi`选择；该选择作用于本次受控 Desktop，不修改官方安装、用户配置或全局环境。
- 当本次启动选择 Pi时，Host Runtime在接收真实 `thread/start`的同一处理步骤中绑定内部 `codexhost/pi-native` transport model。该 ID只作为协议路由令牌；领域内部继续把 Pi表达为 Harness。
- Pi `thread/start`不进入官方 Codex Agent Loop；Host Runtime创建进程内 Pi Thread归属并返回当前 Desktop所需的最小兼容 Response/Event。
- 对已归属 Pi的 Thread，将 `turn/start`文本输入发送到本地 `pi --mode rpc`，把真实 Pi文本增量、完成和明确错误投影回 Codex UI；同一 Thread的第二个 Turn继续使用同一 Pi Native Session。
- `--agent codex`、Codex Thread和未知非 Host消息默认透明转发官方 app-server；不枚举或重写全部官方协议。
- 删除已证明不能驱动当前 Desktop picker的生产 `model/list`/临时 Catalog增强路径。

## Capabilities

### New Capabilities

- `pi-model-routed-vertical-slice`: 通过 Launcher显式 Agent选择和 app-server创建边界传递技术 PoC的 Pi Harness创建意图，并完成 Pi Thread、首轮与同 Thread第二轮文本闭环。

### Modified Capabilities

无。

## Impact

- `crates/launcher`：拥有本次受控 Desktop的显式技术 PoC Agent选择。
- `crates/shim`：从纯官方 CLI透明代理扩展为在显式 codexhost配置下启动正式 Host Runtime，同时保留普通 CLI透明行为。
- `packages/host-runtime`：拥有 app-server子进程组合、进程级 Agent创建绑定、显式接管路由和生命周期。
- `packages/protocol-core`：拥有当前版本所需的 JSONL framing、transport model解码和 Codex/Pi路由。
- `packages/adapters/pi`：实现当前 PoC所需的 Pi RPC Session、文本 Turn和有界关闭，不复制 Gate C工具代码的 Gate-only接口。
- 不修改官方 Codex Desktop安装、`app.asar`、`~/.codex`或全局环境，不依赖 direct CDP、private Renderer export、`params.codexhost` carrier或官方影子 Thread。
- 该方案属于技术 PoC。公开 MVP仍必须提供页面内独立 Agent选择语义，并将 Agent与 Model分开展示。
