# Tasks

## 1. 协议对接

- [x] 1.1 按固定 tag 审计 `dsh-v0.2.1-rc.2` → `dsh-v0.2.1-rc.5`（19 个提交）与 `dsh-v0.2.1-rc.5` → `dsh-v0.2.2-rc.1`（2623 个提交）中 codexhost 使用的对接点，并逐条比对 `docs/persistence-schema.json`。验证：rc.3 至 rc.5 没有持久化或 Remote 变化；`0.2.2-rc.1` 只有四条共用消息来源的根变化，Remote 变化逐项写入验证记录。
- [x] 1.2 control 流接受多键投影帧。验证：`control-store.test.ts` 正反例；改动前正例失败；真实 CLI 新建会话。
- [x] 1.3 分页接受回显截止点的页面，follow 请求恢复 Agent。验证：`journal.test.ts`、`v4-journal.test.ts`、Adapter 测试；真实 CLI 110 个回合冷恢复与崩溃恢复。
- [x] 1.4 Fork 接纳没有来源字段的子会话。验证：Adapter 测试；真实 CLI Fork 与生命周期 Gate 的回滚。
- [x] 1.5 模型 badge 与授权提问。验证：`catalog.test.ts`、`event-gateway.test.ts`、`session.test.ts`；未用真实 CLI 触发，写入验证记录。

## 2. 验证与发布信息

- [x] 2.1 真实 CLI：隔离安装 `0.2.2-rc.1`、`0.2.1-rc.3` 至 `rc.5`，以及 `0.2.1-rc.2`、`0.2.0-rc.2`、`0.1.7-rc.1`，跑生命周期 Gate；在 `0.2.2-rc.1` 上分别去掉单项修复做对照；回放 DSH 自带快照。验证：结果写入验证记录。
- [x] 2.2 已验证版本列表、低版本提示、插件 notice 与连接页文案加入四个版本。验证：`generation-selector`、Adapter 与设置页测试。
- [x] 2.3 更新验证记录与提及已验证版本的文档。验证：`git grep` 不再残留只列到 `0.2.1-rc.2` 的表述。
