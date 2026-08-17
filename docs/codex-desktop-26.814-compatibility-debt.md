# Codex Desktop 26.814 兼容性记录

本文记录本地 Codex Desktop 更新后，codexhost Renderer 注入和 Agent/Model 选择遇到的问题，以及为了兼容旧版 Codex 暂时保留的代码。本文不是 Codex Desktop 内部 API 的稳定契约；更新 Codex 后应重新做现场探针。

## 现场环境

- Codex Desktop：`26.814.41407`
- Codex Framework：`151.0.7922.137`
- codexhost 启动方式：仓库根目录执行 `npm start`
- Renderer：当前 Codex 的 `app://-/index.html` 主窗口
- 本次修复验证日期：以当前工作区验证记录为准

## 用户现象

更新 Codex Desktop 后出现过以下现象：

1. Agent 菜单能显示，但点击 `Claude Code`、`DeepSeek Harness` 或 `Grok` 后没有实际切换效果。
2. Model 按钮显示 `Models unavailable`。
3. 标题隔离兼容性检查提示新的标题服务标识未被识别。
4. Adapter 有时已经显示 `ready`，但外部 Agent 的模型目录仍然加载失败。

这些现象最初看起来像 Renderer 注入失败，实际包含多个独立问题。

## 根因

### 1. Request Bridge 的内部结构发生变化

旧版 codexhost 依赖 `Function.prototype.toString()` 和函数闭包中的私有字符串查找请求入口，例如：

- `send-cli-request-for-host`
- `messageHandler`
- `thread-prewarm-start`
- `prewarm-thread-start-for-host`

Codex `26.814.41407` 中，Composer Fiber 里实际存在两层请求对象：

- 外层业务对象：`sendRequest` 只是委托到 `requestClient.sendRequest(...)`。
- 内层真实 Host bridge：包含 `hostId: "local"`、`sendRequest`、`prewarmThreadStart`，并通过原型提供 `enqueueRequest`。

Codex 更新后函数实现被重写，旧的私有字符串不再稳定。codexhost 仍然可以在启动阶段安装路由，因此 Adapter 会显示 `ready / request-bridge`；但后续 Model 请求重新查找 active prewarm target 时，如果仍依赖函数源码，就会找不到请求对象。

### 2. 注入顺序暴露了动态查找问题

当前启动顺序大致是：

```text
执行 Renderer bundle
    -> 建立 Agent/Model 控制
安装 draft routing policy
    -> 替换 requestClient.sendRequest/prewarmThreadStart
点击外部 Agent
    -> Model client 重新查找 active prewarm target
```

如果动态查找依赖原始函数源码，policy 替换后就会失效。结果是本地 Agent 状态可能已经改变，但外部模型目录无法通过请求 bridge 加载。

当前代码已经改为优先使用稳定 API 形状：

```text
hostId === "local"
has sendRequest
has prewarmThreadStart
has enqueueRequest
```

### 3. 旧版 prewarm 清理 RPC 已被移除

旧版切换 Agent 前会发送：

```text
clear-prewarmed-threads-for-host
```

在 Codex `26.814.41407` 中实际返回：

```text
Invalid request: unknown variant `clear-prewarmed-threads-for-host`
```

这会中断 Agent 切换流程，界面最终表现为 Agent 不生效和 `Models unavailable`。

当前版本已经通过外层 manager 的正式生命周期对象清理 prewarm Thread：

```text
prewarmedThreadManager.discardAllPrewarmedThreads()
```

该对象内部会使用当前 Codex 支持的 `thread/delete` 流程，不再发送未知 RPC。

### 4. 标题服务内部标识变化

Codex 更新后标题服务的压缩内部标识从此前观察到的 `tTe` 变为 `HTe`。现场确认标题服务结构仍然兼容后，codexhost 删除了基于这个内部标识的白名单检测。

标题策略现在只检查实际需要的服务结构和方法是否存在。后续 Codex 仅改变压缩名称时，不会再触发用户可见的兼容性提示；如果标题服务结构或方法契约发生变化，安装仍会失败并进入真实的兼容性错误路径。

## 当前有效代码

以下代码是当前 Codex `26.814.41407` 所需的有效路径：

| 文件 | 当前作用 |
| --- | --- |
| `packages/desktop-control/src/renderer-draft-prewarm-policy.ts` | 从当前 Composer Fiber 识别 outer manager、inner request client，并传递 `prewarmedThreadManager`。 |
| `packages/desktop-control/src/renderer-draft-prewarm-runtime.ts` | 在真实 Host bridge 上路由 `thread/start` 和 `prewarmThreadStart`，并调用当前 Codex 的 prewarm manager 清理 API。 |
| `packages/renderer-extension/src/versioned-renderer-adapter.ts` | 通过稳定 API 形状重新发现被 policy 包装后的 active request target。 |
| `packages/renderer-extension/src/renderer-binding-probe.ts` | 在 Harness availability 的初次检查遇到启动竞态时进行有界重试。 |
| `packages/desktop-control/src/main-process-title-policy.ts` | 验证标题服务结构，并安装标题隔离策略。 |

## 仍保留的旧代码

以下代码目前没有删除，是有意保留的兼容 fallback。它们不是当前 Codex 的首选路径。

| 位置 | 旧逻辑 | 当前状态 | 未来删除条件 |
| --- | --- | --- | --- |
| `packages/desktop-control/src/renderer-draft-prewarm-runtime.ts:103` | 当没有 `prewarmedThreadManager` 时发送 `clear-prewarmed-threads-for-host`。 | 兼容旧版 Codex；当前版本有 manager 时不会走这里。 | codexhost 不再支持缺少 `prewarmedThreadManager` 的 Codex 版本后删除。 |
| `packages/desktop-control/src/renderer-draft-prewarm-runtime.ts:227-244` | 通过 `sendRequest` 的 `[[Scopes]]` 查找包含 `messageHandler` 的旧 Host bridge。 | 旧版 bridge fallback；当前版本优先按 API 形状识别。 | 所有支持版本都提供稳定的 `requestClient` 结构后删除。 |
| `packages/renderer-extension/src/versioned-renderer-adapter.ts:310` | 通过 `send-cli-request-for-host` 判断旧版 active manager。 | 保留给旧版 Codex；当前版本通常走 inner bridge 的稳定 API 形状。 | 不再支持旧版 prewarm manager 结构后删除。 |
| `packages/renderer-extension/src/versioned-renderer-adapter.ts:326-327` | 通过 `thread-prewarm-start` 或 `prewarm-thread-start-for-host` 判断旧版 prewarm 方法。 | 旧版函数源码特征 fallback。 | 完成最低支持 Codex 版本收敛后删除。 |
| `packages/desktop-control/src/renderer-draft-prewarm-runtime.ts:61` | 兼容旧版 `prewarm-thread-start-for-host` 和 `send-cli-request-for-host` 参数包装。 | 旧版请求路由 fallback；当前版本同时支持直接 `thread/start`。 | 所有支持版本都使用 `thread/start` / `prewarmThreadStart` 后删除。 |
| `packages/desktop-control/test/renderer-draft-prewarm-policy.test.ts` | 覆盖旧版清理 RPC、旧版 bridge 和旧版参数包装。 | 防止删除兼容分支时丢失旧版支持。 | 对应生产 fallback 删除后同步删除或改写。 |
| `packages/renderer-extension/test/versioned-renderer-adapter.test.ts` | 覆盖旧版源码特征识别。 | 保留旧版兼容行为的回归测试。 | 对应源码 fallback 删除后同步删除。 |

行号会随后续编辑变化，以上路径和逻辑名称比固定行号更可靠。

## 计划删除方式

删除前先确定 codexhost 的最低支持 Codex Desktop 版本，例如在发布说明或兼容性矩阵中明确记录。不要只因为当前本机版本通过，就直接删除旧分支。

建议按以下顺序清理：

1. 记录最低支持 Codex 版本，并在该版本和当前版本各做一次现场探针。
2. 确认所有支持版本都提供：
   - `hostId: "local"`
   - `sendRequest`
   - `prewarmThreadStart`
   - `enqueueRequest`
   - `prewarmedThreadManager.discardAllPrewarmedThreads`
3. 删除旧版 `Function.toString()` / `[[Scopes]]` bridge 查找逻辑。
4. 删除 `clear-prewarmed-threads-for-host` fallback。
5. 删除旧版 `prewarm-thread-start-for-host` 和 `send-cli-request-for-host` 路由分支。
6. 同步删除只服务于这些 fallback 的测试和错误处理。
7. 用真实 Composer 完成以下回归：
   - 新 Thread 从 Codex 切换到每个外部 Agent。
   - 外部 Agent 的 Model 目录能够加载。
   - 在 Agent 之间连续切换后，下一次 Thread/start 使用当前选择的 Model。
   - 切回 Codex 后，原生 Codex draft 仍然可用。
   - 已锁定 Thread 不允许错误地切换 Agent。

## 本次验证记录

本次针对 Codex `26.814.41407` 的现场验证结果：

- 标题策略：安装成功，无内部标识兼容性警告
- Renderer Adapter：`ready / request-bridge`
- `pi`、`claude-code`、`deepseek-harness`、`grok` availability：全部 `ready`
- `policy.clear()`：成功
- 点击 `Claude Code`：Agent 从 `pi` 切换为 `claude-code`
- Model：显示 `deepseek-v4-flash / Auto`，按钮可用
- 聚焦测试：52 个测试通过
- TypeScript 构建：通过
- Prettier：通过
- `git diff --check`：通过

## 相关代码

- `packages/desktop-control/src/renderer-draft-prewarm-policy.ts`
- `packages/desktop-control/src/renderer-draft-prewarm-runtime.ts`
- `packages/renderer-extension/src/versioned-renderer-adapter.ts`
- `packages/renderer-extension/src/renderer-binding-probe.ts`
- `packages/desktop-control/src/main-process-title-policy.ts`
