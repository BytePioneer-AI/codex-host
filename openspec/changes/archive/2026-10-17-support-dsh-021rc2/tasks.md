# Tasks

## 1. 协议对接

- [x] 1.1 按固定 tag `dsh-v0.2.1-rc.1` → `dsh-v0.2.1-rc.2`（9 个提交）审计 codexhost 使用的对接点，并逐条比对两个 tag 的 `docs/persistence-schema.json`。验证：只有 `web/deepseek-search-llm-request` 一条记录的 schema 变化，无新增或删除；审计写入验证记录。
- [x] 1.2 V4 日志校验接受辅助搜索请求体的可选 `thinking: {type: "disabled"}`。验证：`v4-journal.test.ts` 正反例、rc.2 实录夹具回放、`session.test.ts` 实时回合；改动前这些用例失败。

## 2. 验证与发布信息

- [x] 2.1 真实 CLI：隔离安装 `0.2.1-rc.2`，stub 模型让 DSH 调用 `web_search`，分别以改动前后的 Adapter 对照；再跑生命周期 Gate 与 bash / `working_directory` 工具探测。验证：结果写入验证记录。
- [x] 2.2 已验证版本列表、低版本提示、插件 notice 与连接页文案加入 `0.2.1-rc.2`。验证：`generation-selector`、Adapter 与设置页测试。
- [x] 2.3 更新验证记录与提及已验证版本的文档。验证：`git grep` 不再残留只列到 `0.2.1-rc.1` 的表述。
