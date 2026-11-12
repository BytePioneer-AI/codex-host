# Tasks

## 1. Skill 库

- [x] 1.1 新建 Skill 库包：目录清单、有界异步扫描、frontmatter 解析、真实路径去重、全局与工作区索引、新鲜期校验、并发合并与过期结果保护、错误保留。验证：单元测试覆盖嵌套与深度、符号链接循环、无效 frontmatter、已有目录新增 `SKILL.md`、权限错误保留旧结果、同名保留、过期任务不覆盖新索引；`tools/check-boundaries.mjs` 登记依赖方向，`npm run lint` 通过。
- [x] 1.2 `shared-contracts` 新增 Skill 查询与变化通知契约；Host Runtime 启动后后台建全局索引，会话或草稿得到工作区时建工作区索引，提供 `codexhost/skills/list` 与 `codexhost/skills/changed`。验证：Host 测试覆盖查询不做文件读取、首次扫描短期限与 `complete: false`、变化后版本递增并通知、查询不启动 Harness。

## 2. 删除外部 Harness 的 Skill 命令链路

- [x] 2.1 `harness-adapter` 与 Claude Code、Pi、OMP、Grok、Kiro CLI、CodeBuddy、Hermes Adapter 不再把原生 Skill 放入命令目录。验证：各 Adapter 现有目录测试改为断言 Skill 被排除；live 目录就绪后手工 `/Skill名` 被 Host 按未知命令拒绝；官方 Codex 命令目录与 Skill 输入测试保持通过。

## 3. Web

- [x] 3.1 Web 外部 Harness 会话与草稿的 Skills 分组改由 Skill 库提供，本地搜索，变化通知时更新；删除旧 Skill 行；选中插入规范文本引用；输入框与用户消息显示 Skill chip；官方 Codex 维持原生 Skill。验证：浏览器测试覆盖草稿与已创建会话、句中多个引用的提交文本、运行中发送走排队或 Steer、刷新后 chip、复制得到完整链接、手机宽度菜单。

## 4. Desktop

- [x] 4.1 Desktop `#` 菜单外部 Thread 与草稿的 Skills 分组改由 Skill 库提供；选中后外部 Harness 收到规范文本；输入框与用户消息显示 Skill chip。验证：renderer-extension 与 Host 测试覆盖插入、还原与提交文本；按 codexhost-isolated-testing 在隔离 Desktop 环境实测，不能实测时如实报告。

## 5. 文档

- [x] 5.1 更新 `docs/architecture/harness-command-integration.md`、`docs/product/standalone-web.md`，新增 Skill 库功能文档并登记 `docs/index.md`。验证：链接有效，描述与实现一致。
