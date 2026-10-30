# 设置页样式约定（Tailwind CSS）

适用范围：codexhost 设置页，即 `packages/renderer-extension/src/settings/` 下挂载在设置页 Shadow DOM 内的界面。

## 结论

- 新增的设置页和组件使用 Tailwind CSS 工具类。
- 现有 `shell.css`、`accounts.css` 暂不整体迁移；大改某个页面时，顺带迁移该页面并删除对应的旧样式。
- 可复用控件沉淀在 `settings/preference-ui.ts`（分组卡片、开关、带单位数字输入、问号浮窗），不引入外部组件库，保持 Codex 风格可控。

## 使用边界

- Tailwind 只在设置页 Shadow DOM 内使用。
- 注入 Codex Desktop 页面本身的界面（模型选择器、Composer 控件等）不得使用本项目的 Tailwind 类，也不得把编译结果注入 Desktop 文档。Desktop 自身使用 Tailwind v4，类名、`--tw-*` 变量和 cascade layer 名称相同但主题不同，会互相覆盖。

## 构建方式

- 入口为 `settings/tailwind.css`，由 `shell.ts` 导入一次，所有设置页共用同一份样式。
- `scripts/tailwind-esbuild-plugin.mjs` 在 esbuild 打包时编译该入口：renderer 构建（`scripts/build.mjs`）和打包 renderer 代码的 e2e 用例都需接入该插件。
- 只引入 Tailwind 的 theme 与 utilities，不引入 preflight；元素级基础样式由 `shell.css` 的 `@layer base` 提供。
- 插件显式声明 layer 顺序 `properties, theme, base, components, utilities`，保证工具类覆盖基础样式。
- Chromium 不在 Shadow DOM 中注册 `@property`，插件把其初始值展开为 `@layer properties` 中的普通声明，使 ring、shadow、transform、divide 等工具类正常工作。
- Vitest 不编译 CSS，单元测试不依赖样式内容；视觉效果由设置页 e2e 与人工检查覆盖。
- Tailwind 为构建期依赖；编译产物进入发布包，发布包附带 `tailwindcss-LICENSE.txt`。

## 编写规则

1. 颜色只使用映射后的 `settings-*`（另保留 `white`、`black`），Tailwind 默认调色板已关闭；深浅色随 `--settings-*` 变量自动适配。
2. 类名必须以完整字符串出现在源码中，不能拼接。例如 `bg-settings-${state}` 不会被扫描生成；按状态切换使用 `data-[state=…]:`、`group-data-[…]:` 等变体，或以对象映射完整类名。
3. 扫描范围为 `src/settings/`（入口中的 `@source "./"`）。在其他目录编写设置页界面时，需要在入口追加对应的 `@source`。
4. 同一元素不要同时使用旧 CSS 类与 Tailwind 工具类：旧 CSS 未分层，优先级高于工具类。
5. 重复出现的控件封装进 `preference-ui.ts`，页面中不复制长类名；新写的过长类名按布局、颜色、状态分段拼接，保持可读。
6. 设置页不放大段文字：每行只保留标题、一行描述和控件，详细说明放入问号浮窗。开关使用 `role="switch"`；浮窗使用 `role="tooltip"`，支持悬停、键盘聚焦和 Esc 收起。

## 升级与验证

- 升级 Tailwind 版本时，检查插件输出中的 layer 顺序声明与 `@property` 展开结果，并运行设置页 e2e：`renderer-idle-release.spec.ts`、`renderer-settings-accounts.spec.ts`。
