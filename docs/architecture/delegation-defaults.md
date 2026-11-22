# 委派默认模型与设置页

Codex Desktop 与独立 Web 设置共用「多 Agent 协作」页面（`packages/renderer-extension/src/settings/delegation-page.ts`，page ID `delegation`），用于展示多 Agent 委派回流示意与配置各 Harness 被委派时的默认 Model 与 Thinking 选项。

## 存储与共享

- 默认委派配置保存在共享偏好文件 `harness-preferences-v1.json` 的 `values.delegation.byHarness[harnessId]` 中，仅保存 Model Ref 与 Thinking Option ID（旧版本的编码 Ref 读取时按 [Model Ref](harness-plugin-runtime.md#model-ref) 规则转换），与普通新会话偏好 `newThread` 隔离，支持官方 `codex` 与外部 Harness。
- 设置页通过既有 `codexhost/harness/preferences/{get,patch,changed}` RPC 读写与同步；将某 Harness 的配置设为 `null` 即清空覆盖并恢复跟随 Agent 原生默认。

## 页面列表与按需目录读取

- 「委派」设置页固定在首位展示内置 `codex`，其余复用本机连接诊断缓存中 `availability === "ready"` 的 Harness，不展示未安装或未就绪项。
- 首屏只读取偏好快照与已有本机连接状态，不并发探测全部模型目录；用户聚焦或点击某行下拉框时，按需对该 Harness 调用一次 `codexhost/harness/inspect`（默认 `refresh: false`），填充可用模型与所选模型支持的 `supportedThinkingOptionIds`。不支持 Thinking 选择或当前模型无可用档位时隐藏思考强度选择器。
- 页面使用设置壳的 `@container codexhost-settings-page (max-width: 760px)` 切换宽屏与窄屏布局，Web 设置通过 `codexhost-settings.js` 复用同一页面实现。

## 委派启动解析

新建委派在最终创建子 Thread 的 `HarnessDelegationCoordinator.start`（及官方 `codex` 路径）按「本次显式指定 › 委派默认设置 › Agent 原生默认」合并配置：

- 仅当本次委派未显式指定 `--model` / `--thinking` 时读取对应默认值；不改变 CLI 参数协议或外部 HTTP/MCP 接口。
- 仅显式指定了与已保存默认不同的 `--model` 时，不继承已保存默认中的 `thinkingOptionId`。
- 已保存的默认模型或思考强度若不再被目标 Harness 当前目录支持，或仅为校验保存默认而触发的目录检查失败时，静默回退到 Agent 原生默认且不改写用户配置；调用方本次显式传入非法参数仍返回 `INVALID_ARGUMENT`。
- `requestId` 与短时去重摘要基于调用方原始请求计算，修改委派默认配置不影响已有 `requestId` 的幂等重试。
