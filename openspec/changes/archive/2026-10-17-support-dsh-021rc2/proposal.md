## Why

DSH `0.2.1-rc.2`（npm `next`）在 `0.2.1-rc.1` 之上只改了一处持久化记录：辅助搜索请求 `web/deepseek-search-llm-request` 的请求体新增可选的 `thinking` 成员。默认配置下 `web-search-deepseek` 提供者每次搜索都会写入 `thinking: {"type":"disabled"}`，而 Adapter 对该请求体只允许四个固定成员，因此首次 `web_search` 调用就使 Session 以 `protocolError` 故障，DSH 里的原生回合却继续执行完。

## What Changes

- V4 日志校验接受辅助搜索请求体的可选 `thinking`，取值只能是 `{type: "disabled"}`；其他取值或额外成员仍报协议错误。
- 将 `0.2.1-rc.2` 列入已验证版本，低版本提示与升级命令随之指向它；插件 notice、设置页连接说明和验证记录同步更新。
- 新增 rc.2 实录的 V4 回放夹具，验证记录补充 rc.2 源码审计与真实 CLI 复验。

## Decisions

- 本变更并入同一个尚未合并的 `support-dsh-021rc1` PR：两个版本的已验证列表、升级命令和文档在同一批文件里，拆成两个 PR 会互相冲突。
- 升级命令继续跟随“最新已验证版本”，因此指向 npm `next` 上的 `0.2.1-rc.2`；首次安装与“更新 CLI”仍跟随 npm `latest`，不变。
- `thinking` 只放行 DSH 实际写入的 `disabled`。`enabled` 等取值在 DSH 的持久化 schema 中不存在，出现时按协议错误处理。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deepseek-versioned-web-protocol`: 已验证版本加入 `0.2.1-rc.2`；V4 日志校验接受带 `thinking: disabled` 的辅助搜索请求。
- `deepseek-harness-fast-session`: 已验证版本列表加入 `0.2.1-rc.2`。

## Impact

- `packages/adapters/deepseek-harness`：`modern/history.ts`、`generation-selector.ts`、`manifest.json` 及测试；新增 rc.2 实录回放夹具。
- `packages/renderer-extension`：连接页支持版本文案（中英）。
- 文档：`docs/harnesses/deepseek/` 与 `docs/architecture/` 中提及已验证版本的文档。
- 不改 Host、`shared-contracts` 或公共插件契约。
