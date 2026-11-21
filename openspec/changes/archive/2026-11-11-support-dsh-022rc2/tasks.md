# Tasks

## 1. 协议对接

- [x] 1.1 按固定 tag 审计 `dsh-v0.2.2-rc.1` → `dsh-v0.2.2-rc.2`（1568 个提交）中 codexhost 使用的对接点，并逐条比对 `docs/persistence-schema.json`。验证：持久化根新增 `team/mode`，`subagent/catalog`、`team/task` 与四条共用消息来源的根变化；Remote 变化逐项写入验证记录。
- [x] 1.2 接受第 3 版子代理目录项、`team/mode` 与带 `ownerName` 的 Team 任务。验证：`v4-journal.test.ts` 正反例与 `session.test.ts` 实时回合；改动前正例失败；真实 CLI 子代理、Team 默认开启与 rc.1 → rc.2 升级探测。
- [x] 1.3 按 DSH 的 schema 接受第 1 版子代理目录项（v3 → v4 迁移为无法还原的子会话写入 mode 为 `unknown` 的条目）。验证：`v4-journal.test.ts` 正反例与第 0、1、3 版并存的回归用例；改动前正例失败。

## 2. 验证与发布信息

- [x] 2.1 真实 CLI：从源码打包并隔离安装 `0.2.2-rc.2`，从 npm 隔离安装 `0.2.2-rc.1`，跑生命周期 Gate；修复前后分别跑探测；回放 DSH 自带快照。验证：结果写入验证记录。
- [x] 2.2 已验证版本列表、低版本提示、插件 notice 与连接页文案加入 `0.2.2-rc.2`。验证：`generation-selector`、Adapter 与设置页测试。
- [x] 2.3 更新验证记录与提及已验证版本的文档。验证：`git grep` 不再残留只列到 `0.2.2-rc.1` 的表述。
