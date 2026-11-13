# Tasks

## 1. Host 树关系（契约、持久化、方法）

- [x] 1.1 在 `shared-contracts` 定义 `codexhost/thread/tree/read` 与 `codexhost/thread/tree/place` 的参数和结果 schema；在 `mapping-store` 新增独立的放置文件读写（版本化、原子替换、读取失败时按无放置处理、旧版本可忽略），不修改 Thread 记录与委派记录的格式。验证：仿照 `packages/mapping-store/test/section-placements.test.ts` 新增聚焦测试，覆盖写入后重启恢复、明确顶层、删除记录、损坏文件不影响 Thread 记录；用 `npx vitest run --config tests/vitest.config.js packages/mapping-store/test/<新文件>` 运行。
- [x] 1.2 在 `host-runtime` 的独立模块中实现两个方法并接入 Host 路由：合并“手动放置 ?? 委派父 Thread”，校验归属确认、非 Subagent、不是自身或后代，不满足时返回 `INVALID_ARGUMENT` 且不写入。验证：新增聚焦测试，覆盖委派自动成为父 Thread、手动放置覆盖委派、移到顶层后不回到委派父 Thread、多层链、成环与 Subagent 被拒绝、官方 Thread 与外部 Thread 都可放置，并确认 `codexhost thread list --parent` 的结果不受放置影响；运行相关 vitest 文件和 `node tools/check-boundaries.mjs`。

## 2. Web Server

- [x] 2.1 在 `ch-host-client.ts` 白名单加入两个方法；列表刷新时读取树关系，摘要的 `projectionValues` 加入 `threadTreeParent`（不复用 `parentSessionId`、`origin`），`catalogKey` 纳入该字段；补齐已加载行缺失的祖先（去重、深度上限、遇到环时停止）；新增 `session/place` RPC，拒绝远程和草稿 ID。验证：在 `packages/web-server/test` 新增 Node 聚焦测试，覆盖子 Thread 在第一页而父 Thread 未加载时祖先被补入、关系变化触发 catalog 推送、委派子 Thread 仍保留输入能力和 `nativeDiscovery`、远程 ID 被拒绝；用 `node --import tsx --test <文件>` 运行。
- [x] 2.2 `session/archive` / `session/unarchive` 按树关系级联到全部后代（包括未加载的），先父后子，逐个复用现有归档路径，部分失败时返回失败 ID 且不回滚已成功的项。验证：聚焦测试覆盖多层级联、恢复级联、单独归档子 Thread、部分失败报告；在 Desktop 路径（直接调用 Host `thread/archive`）中不发生级联。

## 3. Web UI 侧栏

- [x] 3.1 新建 `ui-workspace/src/client/thread-tree.ts` 纯函数模块：建树、孤儿/环/不可见父 Thread 降级为顶层、子树汇总状态（运行中、待处理交互、未读完成）、子树最近更新时间、后代数量、后代 ID 列表。`tree.ts` 只对顶层节点套用现有分组、置顶分区、手动排序和 `sidebarWindow`；子 Thread 跟随顶层节点所在分组；非顶层节点按未置顶处理。验证：在 `ui-workspace/test` 新增单元测试，覆盖三层链、跨工作区子 Thread 只出现一次、按更新时间排序使用子树时间、手动排序只作用于顶层、子节点按自身时间倒序、已置顶子 Thread 不进置顶区、父 Thread 已归档时子 Thread 降级为顶层、运行中后代使祖先不被截断。
- [x] 3.2 行渲染与交互：缩进 `min(depth, 3)`，加展开箭头和子 Thread 数量；收起时显示子树汇总状态；展开状态按 Thread ID 保存在浏览器本地，默认收起，导航（链接、搜索、通知）到某个 Thread 时展开其祖先；键盘可展开、收起；子节点禁用排序拖动，但保留拖入聊天区域作为会话引用；子节点隐藏置顶菜单项；归档确认列出整棵子树中运行中的 Thread；搜索结果保持平铺并显示父 Thread 标题。验证：沿用 `test:web:browser` 的配置新增聚焦浏览器用例（可参考 `ch-sidebar-pins.test.ts`、`ch-sidebar-archives.test.ts`），并检查桌面宽度和 390px 手机宽度的截图：收起/展开、深层缩进不出现横向滚动、汇总状态、刷新后保持展开。
- [x] 3.3 手动放置菜单：行菜单的“移到…下”打开使用现有 `Modal` 的可搜索选择器（同一 Host、未归档、非草稿、非 Subagent、非自身及后代）；有显示父 Thread 的行显示“移到顶层”；远程 Thread 不显示这两项；失败时显示提示，位置不变。验证：聚焦浏览器用例覆盖移到其他 Thread 下（目标祖先展开）、委派子 Thread 移到顶层后刷新仍为顶层、候选项排除自身及后代、手机宽度下通过菜单完成放置，并检查截图；中英文文案加入 `locales.ts`。

## 4. 收尾

- [ ] 4.1 （主导者完成）新增 `docs/architecture/web-thread-tree.md`，说明显示父 Thread 的规则、Host 方法、持久化文件和 Web 行为边界；更新 `docs/index.md` 和 `docs/product/standalone-web.md`。运行 `npm run typecheck`、`npm run lint`、`npm run build:web:ui`、`openspec validate add-web-thread-tree --strict`，只报告实际执行过的检查。
