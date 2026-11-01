# Tasks

## 1. 协议对接

- [x] 1.1 按固定 tag `dsh-v0.2.0-rc.2` → `dsh-v0.2.1-rc.1` 审计 codexhost 使用的对接点（启动参数、就绪行、认证、Remote RPC、`$events`、flush、Session Format、流式 chunk、会话列表）。验证：审计表写入验证记录。
- [x] 1.2 V4 日志校验接受 `job/registered`、`job/settled`、`working-directory/change`、标题请求 `reasoningEffort`、PTC 子调用 `meta`、`subagent/catalog` v2。验证：`v4-journal.test.ts` 正反例、rc.1 实录夹具回放、`session.test.ts` 实时回合；改动前这些用例失败。
- [x] 1.3 会话列表接受 `formatStatus`。验证：`session-list.test.ts` 正反例。

## 2. 验证与发布信息

- [x] 2.1 真实 CLI：隔离安装 `0.2.1-rc.1` 与 `0.2.0-rc.2`，跑生命周期 Gate 与 bash / `working_directory` 工具探测，并以改动前的 Adapter 作对照。验证：结果写入验证记录。
- [x] 2.2 修正 Gate 模型桩对标题请求的误判。验证：0.2.1-rc.1 连续 8 次、0.2.0-rc.2 连续 5 次通过。
- [x] 2.3 已验证版本列表、低版本提示、插件 notice 与连接页文案加入 `0.2.1-rc.1`。验证：`generation-selector`、Adapter 与设置页测试。
- [x] 2.4 更新验证记录与提及已验证版本的文档。验证：`git grep` 不再残留只列四个版本的表述。
