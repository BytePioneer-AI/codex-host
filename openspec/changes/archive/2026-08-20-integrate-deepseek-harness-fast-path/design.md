## Context

codexhost 已有 `HarnessAdapter`、通用 external Thread runtime 和 Codex UI projector。DSH 官方 SDK runtime 通过 stdio newline-delimited JSON-RPC 提供 `initialize`、`session/prompt`、`shutdown`，并推送完整 `session.event`；本次约定运行时额外提供最小 `session/cancel`。当前 wire 不支持历史读取和恢复。

## Goals / Non-Goals

**Goals:**

- 通过独立 DeepSeek Harness Adapter 跑通新 Thread、多轮文本、流式文本/Reasoning、工具、Diff 和取消。
- 保持 DSH wire 细节位于 Adapter 内，复用现有 Host/Renderer 抽象。
- 未实现能力通过 capabilities 和 `unsupported` 明确表达。

**Non-Goals:**

- 应用重启后的 Session 恢复、Fork、Rollback 或完整 Thread 管理。
- 提问、审批、权限切换、斜杠命令和运行中 Model/Thinking 切换。
- 通用 Cordis runtime 打包、自动安装或完整跨平台发布 Gate。

## Decisions

1. 新建 `@codexhost/adapter-deepseek-harness`，实现现有 `HarnessAdapter`。Host Runtime 不识别 DSH event name。
2. 每个 live Session 启动一个 runtime 子进程。`initialize` 的 cwd/provider/model 是进程级配置，因此该模型最直接，且 Session close 可以关闭整个进程。
3. Adapter 内实现最小 JSON-RPC transport 和局部运行时校验，不将 DSH RC 类型引入共享契约或浏览器包。运行时挂载官方 `dsh-credentials-local` provider，按 DSH 的 `$DSH_HOME/.credentials.yaml` 规则复用 Web Models 页面写入的凭据；codexhost 不读取、复制或投影凭据值。
4. 首版 `open(create)` 生成 Native Session ID；其他 open kind 返回 `unsupported`。Snapshot 只反映当前进程内已观察到的 Turn，重启恢复不宣称可用。
5. `assistant/chunk` 映射文本/Reasoning增量，`tool/call`/`tool/result` 映射工具生命周期。只有 `tool/result.meta.diffs` 通过严格 shape 校验后映射为 File Change；否则保持 generic Tool。
6. `turn.cancel` 调用约定的 `session/cancel` RPC。运行时不支持时返回明确失败，不能用 UI 假取消。Session close 仍可使用 shutdown 和进程终止完成资源回收。
7. Provider 固定为 `deepseek-official`。Model 由 transport Model carrier 在 Session 创建时传入；Thinking 首版不单独暴露选择器。
8. Renderer 将 DeepSeek Harness 作为第三个外部 Agent，使用 `codexhost/deepseek-harness-native` transport token。保持现有 Agent 选择状态结构，避免本次扩展成通用插件系统。

## Risks / Trade-offs

- [运行时命令不是仓库自带发布物] → `inspect()` 在命令缺失时报告 not installed，并提供显式环境变量；本次只做开发入口。
- [DSH SDK wire 仍为 RC] → 严格握手 server name，未知/畸形核心事件触发 protocol fault，版本升级单独验证。
- [Raw chunk 与 committed message 可能不一致] → 首版按流事件展示并以 committed event 完成 Item，不启用复杂 retry 组合。
- [无恢复导致旧 Thread 重启后不可继续] → capabilities 明确关闭 history；这是快速切片的已知边界，下一阶段补 `session/read/resume`。
- [第三方工具 meta 不稳定] → 只接受结构化 `diffs` 数组，其他结果按 generic Tool 展示。
