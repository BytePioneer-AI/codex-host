## Why

设置以居中模态对话框打开：遮挡整个窗口、锁住左侧导航栏，与 Codex 插件、技能等原生页面的呈现方式不一致。用户希望设置像原生目的地一样，作为左侧导航栏旁的独立页面出现。

## What Changes

- 设置外壳不再使用 `<dialog>`/`showModal()`，改为覆盖左侧导航栏右侧内容区域的非模态页面；位置只读取导航栏几何信息，不插入或修改 Codex 内容区域的 DOM。
- 页面打开期间，导航栏保持可用：点击任一原生目的地、原生当前目的地变化、`popstate`/`hashchange` 或 URL 变化时，设置页让位且不把焦点拉回触发器。
- 打开期间以作用域 CSS 隐藏导航栏原生选中背景，不改写 React 持有的 `data-selected`/`aria-current`；CodexHost 触发器以原生选中样式与 `aria-current="page"` 表示当前页。
- Escape 与关闭按钮继续关闭页面；页面内的模态对话框优先处理 Escape。重复点击触发器不重置当前页。
- 紧凑布局改为按页面自身宽度（容器查询）切换。
- 设置相关请求（更新、账号、Harness 插件目录、凭证导入）在没有 Composer 路由时回退到本地 Host，使设置可在插件等无 Composer 的原生页面上使用；有 Composer 时行为不变。
- 移除公开导出 `isRendererSettingsDialogSupported` 与外壳的 `dialog` 属性，改为 `surface`。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `extensible-settings-shell`：外壳呈现从模态对话框改为导航栏旁的非模态页面，并规定与原生导航的让位关系。

## Impact

- `packages/renderer-extension`：`settings/shell.ts`、`settings/shell.css`、`settings/trigger.ts`、`renderer-settings-lifecycle.ts`、`versioned-renderer-adapter.ts`，新增 `settings/rail-page.ts`。
- 新增 `tests/e2e/renderer-settings-page.spec.ts`；更新外壳与触发器单测。
- 依赖原生导航栏 `nav[data-app-navigation-rail]`、`[data-sidebar-destination]` 与其 `aria-current`（触发器已依赖）；隐藏原生选中背景额外依赖 `[data-selected]::before`。后者失效时只会同时显示原生高亮，不影响功能。
- 不修改 Host Runtime、共享契约、插件 API 或各设置页内容。
