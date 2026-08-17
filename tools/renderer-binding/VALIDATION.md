# Codex Renderer Agent 绑定验证记录

## 当前结论

当前受支持的 Codex Desktop 构建使用 version-locked Renderer Adapter 完成 Composer 级 Agent 绑定：

- Launcher 使用 `codexhost launch` 启动完整 Agent 选择器，不再要求或接受进程级 `--agent` 参数；默认新建 Composer 使用 Codex，其他 Agent 由页面选择器选择。
- Renderer Adapter 为新 Thread 的目标 Composer 维护独立 Agent 状态，并在提交时同步锁定最终选择。
- 选择外部 Harness 时，Adapter 只在对应新 Thread 创建路径写入内部 transport carrier；Codex 选择恢复官方 Model 状态。
- Host 在真实 `thread/start` 边界按 transport carrier 选择 Harness，并按不可变 Thread ownership 路由后续 Turn。
- 现有外部 Thread 不会把 transport carrier 写回 Codex 原生 Model 状态；Model、Thinking 和 Permission 变更通过固定 Host 控制完成。

公共 DOM 和 preload API 仍不提供稳定的通用 Agent-to-create 接口。因此，绑定依赖版本锁定的 Composer Model atom、预热清理桥接和主进程 title policy；结构不匹配、归属不明确或资产不受支持时必须 fail closed。

## 当前验证状态

```text
生产 Renderer 加载全部已注册 Agent：PASS
Composer 级 Agent 选择、切换和提交锁定：PASS
外部 Agent 选择到 transport carrier：PASS
Pi thread/start 到 Pi Native Session：PASS
Pi Thread 后续 Turn 复用同一 Native Session：PASS
Codex / Pi 双向切换及过期预热清理：PASS
Pi title 请求不进入 Codex Harness：PASS
未消费 Pi 预热不启动 Pi 进程：PASS
```

验证使用脱敏的 create、Turn、title 和 Session 观察，不依赖 Prompt、完整 DOM 或完整请求标识。

## 路由关系

```text
页面选择 Agent
-> Composer 状态独立保存
-> 提交时锁定最终选择
-> 外部 Agent 写入对应 transport carrier
-> Host decodeCreateRoute
-> selectedHarness
-> 对应 Harness Native Session
-> 输出回到同一个 Codex Thread
```

Pi 的默认 transport carrier 是：

```text
codexhost/pi-native
```

该字符串是内部路由令牌，不代表领域 Model，也不会作为用户可见或持久化的 Codex Model 配置。

## 受控验证重点

验证一次创建和后续 Turn 时，必须同时满足：

```text
Renderer 选择 Pi
-> 对应 thread/start 携带可验证的 Pi transport carrier
-> Host selectedHarness == pi
-> 创建或复用正确的 Pi Native Session
-> Pi 输出进入同一个 Codex Thread
```

还必须覆盖以下边界：

1. Codex -> Pi、Pi -> Codex 以及 Codex -> Pi -> Codex -> Pi 的过期预热清理。
2. 只有真正消费的 Pi Thread 才启动 Pi Native Session。
3. Pi title 使用 Desktop 本地 fallback，不创建官方 Codex ephemeral Thread。
4. Composer 替换、已有 Thread 重访和 Thread ownership 变化不能转移其他 Composer 的 Agent 或 Model 状态。
5. 结构不匹配、请求桥接不可用或归属不明确时停止绑定，不能静默回退到 Codex。

## 证据位置

- Renderer Agent 状态：`packages/renderer-extension/src/agent-selection-state.ts`
- Renderer 绑定与 Model Adapter：`packages/renderer-extension/src/renderer-binding-probe.ts`
- Versioned Renderer Adapter：`packages/renderer-extension/src/versioned-renderer-adapter.ts`
- Host 路由分类：`packages/host-runtime/src/app-server-host.ts`
- Model 路由协议：`packages/protocol-core/src/model-routing.ts`
- CDP / Inspector 控制：`packages/desktop-control/src/cdp-client.ts`
- 受控运行器：`tools/renderer-binding/run.mjs`
- 测试 Host 入口：`tools/renderer-binding/observed-host.mjs`

脱敏本地证据保存在 Git 忽略目录 `.codexhost/renderer-binding/`，包括 Renderer 状态报告、Host route 分类和分阶段时序报告。这些本地文件不作为可提交产品数据。
