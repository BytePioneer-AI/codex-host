# Harness Discovery 历史分析归档

> **归档状态：已失效，请勿作为当前实现依据。**
>
> 替代文档：[`../../harness-executable-discovery.md`](../../harness-executable-discovery.md)
>
> 替代实现：`2df7058 feat: unify harness executable discovery`

## 归档原因

本目录保存统一 Harness 可执行文件发现机制实施前产生的探索性分析。原始材料存在以下问题：

- 混淆了 Codex Desktop/codexhost 原生应用安装发现与外部 Harness CLI 发现；
- 把不同 Adapter 当时各自实现的查找逻辑描述为长期契约；
- 部分结论已被 `@codexhost/harness-discovery` 替代；
- 部分环境变量名称、搜索目录和支持范围互相矛盾；
- 曾出现“Pi 不支持自动发现”等已经不成立的结论；
- 只覆盖 NVM 等少数目录，没有反映 fnm、Volta、asdf、nodenv、Bun、pnpm 和 Homebrew keg-only Node 的公共发现能力。

## 原始材料清单

实施前曾生成以下五份临时文件：

1. `DISCOVERY-LOCATIONS-SUMMARY.txt`
2. `HARNESS-DISCOVERY-QUICK.txt`
3. `HARNESS-DISCOVERY.md`
4. `codexhost-discovery-analysis.md`
5. `codexhost-discovery-quick-reference.md`

这些文件在进入 Git 历史前已被清理，现已无法原样恢复。为了保留决策上下文，本目录使用下列主题归档替代原始副本：

- [`01-desktop-install-discovery-notes.md`](01-desktop-install-discovery-notes.md)：原生 Codex Desktop/codexhost 安装发现主题；
- [`02-per-adapter-harness-discovery-notes.md`](02-per-adapter-harness-discovery-notes.md)：公共包实施前，各 Adapter 的 CLI 发现方式；
- [`03-invalidated-conclusions.md`](03-invalidated-conclusions.md)：已失效或需要限定条件的结论及替代事实。

这里不伪造丢失文件的逐字内容，只保留从当时工作区检查与后续实现中能够确认的分析主题和错误结论。

## 使用规则

- 排查当前行为时，先阅读替代文档和实现源码。
- 本目录不得被链接为当前安装指南或配置说明。
- 如果未来实现再次变化，应更新当前文档，而不是继续修订本归档。
