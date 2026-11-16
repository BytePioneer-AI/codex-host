# Tasks

## 1. 实时区间与受限能力

- [x] 1.1 核对已安装 CodeBuddy 2.159.0、WorkBuddy AI 5.7.6 与 WorkBuddy 5.6.2 的原生公告、终态和落盘身份，保留 `autonomousTurns.observe`，明确 B12 受限。验证：静态源码位置、哈希；WorkBuddy 能力断言。
- [x] 1.2 按连接公告/结束区间管理内容和 permission/question；串行轮独立，重叠 fault，暂存合计 2048 帧 / 4 MiB。验证：复用 ID 的连续内容、Host 准入/收尾、较早审批/提问、取消重建、close/fault 及总量回归；新回归在旧实现上失败。
- [x] 1.3 删除自主轮历史消费和身份推断；只读历史恢复既有原生规则；终态只取实时区间且无 nativeTurnRef。验证：缺历史、旧时间、cron、失败 Host 遗留、中途/相邻输入、无输出取消及历史展示差异的回归。

## 2. 文档与验证

- [x] 2.1 同步两份集成文档与规格，说明实时范围、重开后的分组差异与尚未在线验证。验证：文档与生命周期、能力声明一致。
- [x] 2.2 执行 format:check、lint、typecheck、build:typescript 及 codebuddy/workbuddy 测试，逐条记录退出码；更新中文 PR 正文。
