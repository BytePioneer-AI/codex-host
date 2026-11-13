# Tasks

## 1. 撤销手动放置的代码与测试

- [ ] 1.1 前端：删除放置菜单（“移到…下”“移到顶层”）、拖动挂靠与停留确认、乐观更新、每层手动顺序及相关文案；顶层拖动排序、置顶分区恢复到会话树合入前的行为，子 Thread 固定按更新时间排序。验证：`npm run build:web:ui`、会话树/置顶/无工作区浏览器用例。
- [ ] 1.2 后端：删除 `codexhost/thread/tree/place`、手动放置持久化（保留 `tree/read`、`tree/changed`）、`session/place` 与 `session/place-invalid`；删除对应测试与假 Host 支持。验证：相关 vitest 与 web-server Node 测试，全仓搜索无悬空引用。

## 2. 文档

- [ ] 2.1 更新 `docs/architecture/web-thread-tree.md`、`docs/product/standalone-web.md`、`docs/index.md` 的描述；`openspec validate remove-manual-thread-placement --strict`。
