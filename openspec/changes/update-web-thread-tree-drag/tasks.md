# Tasks

## 1. 落点与状态机

- [ ] 1.1 在 `rows/thread-drop.ts` 重写落点判定：插入线位置（行内上下各 50%）、中间区域停留 500ms 切换为“子 Thread”、抖动阈值、取消；按更新时间排序时无插入线；非法目标（自身、后代、已归档、远程、草稿、Subagent）无落点。验证：`ui-workspace/test/thread-drop.test.ts` 新增/更新 node:test，覆盖区域划分、停留与取消、各类非法目标。

## 2. 每层手动顺序

- [ ] 2.1 子 Thread 支持手动排序：`sessionOrderByAccount` 按容器记录（顶层沿用，子层 `thread:<parentId>`），reconcile 新增与失效；子 Thread 行可拖动并显示插入线；放置到新父 Thread 时写入目标层顺序。验证：单测覆盖 reconcile、跨层移动写入的顺序；浏览器用例覆盖三层移到顶层的指定位置、子层内重排、刷新后保持。

## 3. 交互与视觉

- [ ] 3.1 提示与菜单：停留进度、“成为 X 的子 Thread”提示、插入线与整行框的视觉区分；桌面隐藏菜单项、触屏保留；锁定“拖到自己分组标题/空白移到顶层”“拖到其他工作区分组仍是移入文件夹”“拖入聊天引用”不变。验证：浏览器用例与 1280/390 截图（拖动中的插入线、停留提示）。
- [ ] 3.2 回归：`ch-thread-tree`、`ch-thread-tree-drag`、`ch-sidebar-pins` 浏览器用例与 `thread-drop`、`thread-tree` 单测。

## 4. 收尾

- [ ] 4.1 更新 `docs/architecture/web-thread-tree.md`、`docs/product/standalone-web.md` 中的拖动与菜单描述；`openspec validate update-web-thread-tree-drag --strict`。
