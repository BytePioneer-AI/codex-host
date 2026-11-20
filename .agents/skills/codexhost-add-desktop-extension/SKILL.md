---
name: codexhost-add-desktop-extension
description: 开发、打包、验收或排查 codexhost Desktop UI 扩展。用 v1 宿主 API 为本机侧栏增加角标、布局或导航；不用于接入 Harness、编写 Web 插件或改变 Thread 行为。
---

# 新增 codexhost Desktop UI 扩展

目标：交付一个能独立安装、热启停、完整卸载的可信 UI 扩展。路径以仓库根目录为基准；字段、签名以 [`packages/shared-contracts/src/desktop-extensions.ts`](../../../packages/shared-contracts/src/desktop-extensions.ts) 为准。

| 需求                                                        | 改动位置                                          |
| ----------------------------------------------------------- | ------------------------------------------------- |
| 可选的 Desktop 本机侧栏角标、归组、展示与导航               | Desktop UI 扩展，默认只改扩展自己的目录           |
| 接入 Agent Harness，提供 Session 执行、历史、模型或账号能力 | [Harness 插件](../codexhost-add-harness/SKILL.md) |
| 改变 Thread 归属、执行、持久化，或增加通用宿主原语          | 在主干设计公共能力，不在扩展里绕过 API            |

## 1. 声明扩展和槽位

从 [`sidebar-delegation-badges`](../../../packages/desktop-extensions/sidebar-delegation-badges) 或 [`sidebar-thread-tree`](../../../packages/desktop-extensions/sidebar-thread-tree) 选一个样板。源码放在 `<source-dir>/src/index.ts`，可选样式为 `<source-dir>/src/desktop.css`。安装目录是 `$CODEXHOST_DATA_DIR/extensions/<id>/`，内有 `manifest.json`、`desktop.js`、可选 `desktop.css`。目录名与 `id` 一致；复制文件不等于启用。

```json
{
  "manifestVersion": 1,
  "id": "example.tree_v1",
  "name": "Example Thread Tree",
  "version": "0.1.0",
  "desktopApi": 1,
  "desktop": { "script": "desktop.js", "style": "desktop.css" },
  "slots": ["sidebar.thread-layout"]
}
```

`sidebar.thread-badge` 用于角标与计数；`sidebar.thread-layout` 用于改变行布局。只声明实际使用的槽位，没有就用 `[]`。扩展必须取得全部声明的槽位才会激活；同一槽位只归一个扩展，启用冲突时管理入口会指出占用者。没有样式时省略 `desktop.style`。

完成条件：manifest 可通过 v1 schema，目录名、入口和槽位与实际产物一致。

## 2. 实现 `define({ activate(api) })`

构建产物为经典 JavaScript，不是 ESM 入口；脚本加载时同步调用一次 `define`。`activate` 可返回清理函数，也可以异步返回清理函数或 `void`。用下列原语实现，不接入私有 React 对象、通用 Host RPC 或原生进程。

| v1 原语                                                            | 用法                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `api.sidebar.observeRows(cb)`                                      | 观察行；跳过 `isLocal === false`、没有 `threadId` 的草稿行和已断开的行。返回取消函数。               |
| `api.threads.watchTree(cb)`                                        | 订阅本机 Thread 树；正确处理 `unknown` 和 `truncated`，不要把它们当作空闲或完整快照。返回取消函数。  |
| `api.navigate.openThread(threadId)`                                | 原生导航；只接受本机 Thread。                                                                        |
| `api.harnesses.describe(harnessId)`                                | 从本机 Harness 目录缓存读名称和可选图标；处理 `undefined`。                                          |
| `api.dom.mount(node, target, position?)`                           | 受管挂载扩展自建节点；位置为 `append`、`prepend`、`before` 或 `after`。                              |
| `api.dom.mark(element, name)` / `api.dom.unmark(element, name)`    | 添加或移除受管标记 `data-cx-<id>-<name>`。                                                           |
| `desktop.style`                                                    | 通过 manifest 声明样式表，由宿主管理安装与移除；没有运行时 `api.dom.style`。                         |
| `api.id` / `api.apiVersion` / `api.signal` / `api.track(teardown)` | 读取身份和版本；给事件监听器传 `{ signal: api.signal }`；用 `track` 登记定时器等额外资源的同步清理。 |

- 只用 `dom.mark` + 扩展样式表装饰或隐藏原生行；绝不直接写原生行的 `style` 或 `class`。ID 含 `.` 或 `_` 时用 `CSS.escape` 转义完整属性名，例如 `` `[${CSS.escape(`data-cx-${api.id}-hidden`)}]` ``；静态 CSS 使用等价转义，如 `[data-cx-example\.tree\_v1-hidden]`。
- `src` 只能导入扩展包内的相对路径和 `@codexhost/shared-contracts`。遵守 Desktop CSP，不能用 `eval` 或 `new Function`。
- API 是稳定性边界而不是沙箱；只安装信任的代码。锚点没有出现时安全降级。

完成条件：远程行不受影响；禁用时原生行恢复，扩展节点、监听器、订阅和定时器均被回收。

## 3. 构建、隔离验收与恢复

1. 用 [隔离实测 Skill](../codexhost-isolated-testing/SKILL.md) 选取单独的数据目录，在同一工作树以该目录运行 Desktop 和 Console。先确认允许启动测试 Desktop，且不会占用正在使用的端口或数据目录。
2. 在仓库根直接构建到扩展根，不用符号链接：

   ```bash
   : "${CODEXHOST_DATA_DIR:?请先设置独立的测试数据目录}"
   npx tsc -b packages/shared-contracts
   node tools/build-desktop-extension.mjs packages/desktop-extensions/sidebar-thread-tree \
     "$CODEXHOST_DATA_DIR/extensions"
   ```

   将样板路径替换为实际源码目录。工具把产物写到 `$CODEXHOST_DATA_DIR/extensions/<id>/`，不改 `enabled.json`。目录和文件须归当前用户所有，不允许同组或其他用户写入。

3. 在 Console 的扩展页启用。确认从等待进入运行中；重复构建一次确认热更新且没有旧实例；禁用后原生行恢复。验证远程行不变；使用同槽位样板验证冲突提示包含占用者。记录实际验证范围。
4. 看不到扩展时，核对数据目录、目录名、manifest 与权限。等待状态时确认 Desktop 主窗口已建立界面控制；失败时先看状态原因和声明的文件，修复后重新构建。若 Desktop 无法操作，在独立的 **Console → 扩展** 选择「禁用全部扩展并重载 Desktop」；选择会立即保存，有在线 Controller 时才执行窗口重载。

完成条件：报告构建产物位置、启停/热更新/冲突结果，以及未验证项。更多约束见 [Desktop 界面扩展](../../../docs/architecture/desktop-ui-extensions.md)。
