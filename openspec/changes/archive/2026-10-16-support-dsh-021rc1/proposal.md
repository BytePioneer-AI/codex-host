## Why

DSH `0.2.1-rc.1`（npm `next`）仍写 Session Format V4，但新增了几类同版本日志记录和会话列表字段。Adapter 的严格 V4 校验把它们判为协议错误：DeepSeek 模型下每个新会话首轮的标题请求、以及任意一次 bash 调用都会使 Session 故障，且故障后该 Thread 无法再打开；会话导入列表也整体失败。`latest` 切到 0.2.1 后所有用户都会受影响。

## What Changes

- V4 日志校验接受 0.2.1 的精确形状：`job/registered` / `job/settled`（每个 bash/pwsh 调用与 workflow 的 job 登记与结束）、`working-directory/change`、标题请求的可选 `reasoningEffort`、PTC 子调用结果的可选 `meta`、外部 Agent 子代理的 `subagent/catalog` v2（mode `external`）。均为 log-only，不生成新 Item；不符合形状的仍报协议错误。
- 会话列表接受每行的 `formatStatus`（`current` / `migration-required`），不改变导入候选。
- 将 `0.2.1-rc.1` 列入已验证版本，低版本提示与升级命令随之指向它；插件 notice、设置页连接说明和验证记录同步更新。
- 真实 CLI Gate 的模型桩不再把 DSH 并发发出的标题请求计为主请求（0.2.1 下该误判在 6 次运行中出现 5 次）。

## Decisions

- 只放行 0.2.1 新增的 v2 子代理目录项。v1（DSH 迁移为未知子代理写入）自 0.1.7 起即存在但一直被拒绝，与本次版本无关，不在本变更中改动。
- 升级命令继续跟随“最新已验证版本”，因此指向 npm `next` 上的 `0.2.1-rc.1`；首次安装与“更新 CLI”仍跟随 npm `latest`，不变。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deepseek-versioned-web-protocol`: 已验证版本加入 `0.2.1-rc.1`；V4 日志校验覆盖 0.2.1 新增的 log-only 记录；会话列表接受 `formatStatus`。
- `deepseek-harness-fast-session`: 已验证版本列表加入 `0.2.1-rc.1`。

## Impact

- `packages/adapters/deepseek-harness`：`modern/history.ts`、`modern/session-list.ts`、`profiles/v4.ts`、`generation-selector.ts`、`manifest.json` 及测试；新增 rc.1 实录回放夹具。
- `packages/renderer-extension`：连接页支持版本文案（中英）。
- `tools/gate-dsh/lifecycle.real.test.mjs`：模型桩的标题请求识别。
- 文档：`docs/harnesses/deepseek/` 与 `docs/architecture/` 中提及已验证版本的文档。
- 不改 Host、`shared-contracts` 或公共插件契约。
