# 归档父 Thread 时归档子 Thread

在侧边栏归档一个有子 Thread 的父 Thread 时，CodexHost 可以一并归档它的子 Thread。子 Thread 与[侧边栏嵌套](sidebar-thread-tree.md)使用同一组关系：委派（Delegation）和 native Fork（`forkedFromId`），递归到任意深度，只包含当前仍列在侧边栏中（未归档）的 Thread。官方 subagent 不计入，行为不变。

## 交互

- 设置位于 设置 › 通用 › 侧边栏 › “归档父会话时”，取值为“每次询问”（默认）、“总是归档子会话”、“从不归档子会话”。选择“每次询问”即可恢复确认对话框。
- 设为“每次询问”时，父 Thread 归档后弹出 Desktop 样式的模态对话框，显示未归档子 Thread 数量和最多 3 个标题，提供“仅归档父会话”和“同时归档 N 个子会话”。勾选“记住我的选择”会把本次选择写入设置。Esc 或点击遮罩等同“仅归档父会话”。
- 偏好保存在 Renderer `localStorage` 的 `codexhost.archive-children.v1`，修改会通过 `codexhost:archive-children-changed` 和 `storage` 事件同步到设置页。

## 实现

- 触发：每个有侧边栏 Thread 的 Host 订阅 app-server 的 `thread/archived` 通知。通知在父 Thread 真正归档之后到达，所以任何归档入口都适用，且父 Thread 的归档从不被阻塞。只有拥有焦点的窗口响应，避免多窗口重复弹窗。
- 子 Thread 计算：`RendererSidebarThreadTree.liveDescendants` 对侧边栏中每个原生行（不含镜像）沿父链向上查找，到达被归档的父 Thread 即计入；已归档的中间层不会截断链。
- 归档方式：逐个调用子 Thread 侧边栏行自身的 `onArchive`，即其归档按钮调用的同一函数，因此置顶、worktree 和撤销提示都与手动归档一致。不直接调用 RPC，也不写存储。每个子 Thread 等待它的 `thread/archived` 通知或行消失后再处理下一个；子 Thread 自身的通知不会再次触发级联。
- 失败：行没有归档入口或 15 s 内未完成时记为失败，继续处理其余子 Thread，最后在侧边栏左下角显示提示，列出未归档的子 Thread。

## 已知边界

- 只处理当前渲染在侧边栏中的子 Thread；未加载或所在分组已折叠的子 Thread 不会被归档，也不计数。
- 撤销父 Thread 的归档不会恢复子 Thread；每个子 Thread 有自己的撤销提示。
- 自动化等非手动入口归档父 Thread 时，若窗口有焦点且存在子 Thread，同样会按设置处理。
- 只改动 Renderer，无需更新 Host；Renderer 更新后需重启 CodexHost 才会加载。

## 验证

`renderer-sidebar-archive-children.test.ts` 覆盖询问、记住选择、总是/从不、无子 Thread、非焦点窗口、失败汇总和原生 `onArchive` 定位；`renderer-archive-children-preference.test.ts` 覆盖默认值、存储、事件和存储不可用；`renderer-sidebar-thread-tree.test.ts` 覆盖 `sidebarThreadDescendantKeys` 和 `liveDescendants`。
