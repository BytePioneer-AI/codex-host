# codexhost 设置界面 · 设计方案 01

独立 HTML/CSS/JavaScript 交互原型，不导入业务包，不调用 API，不保存真实配置。所有账号、连接状态和额度均为示例。

## 查看

直接打开 `index.html` 即可，无需安装依赖。也可以构建后预览：

```sh
npm --prefix design-prototypes/settings-v1 run build
npm --prefix design-prototypes/settings-v1 run preview
```

打开 http://127.0.0.1:48761 。关闭预览服务使用 Ctrl+C。

方案总览：打开 `review.html`，或访问 http://127.0.0.1:48761/review.html 。每页均可进入交互原型或查看完整设计图。

静态预览图：[浅色](previews/settings-light.png) · [深色](previews/settings-dark.png)。

其他页面：[Harness 列表](previews/harnesses-light.png) · [账号与额度](previews/accounts-light.png) · [资源管理](previews/resources-light.png) · [Harness 设置弹窗](previews/harness-dialog-dark.png)。

## 评审范围

- 通用设置：主题缩略图、语言、会话字号、交互与阅读。
- 连接与 Harness：本地 Host 与 Harness 列表，状态和操作对齐。
- 账号与额度：示例账号、额度比例、重置时间。
- 资源管理：空闲释放、等待时间、已加载会话。
- 支持浅色/深色预览、窄屏布局；开关和选项只在当前页面内保留。
- Harness 设置：原生弹窗、自动查找与指定路径、取消与保存；路径在当前页面内按 Harness 分别保留。
- 语言选择仅演示控件状态，不翻译页面；插件目录只展示入口提示。
- 页面与配色可通过 URL 直接打开，例如 `index.html?page=accounts&theme=dark`；添加 `dialog=claude` 可打开 Claude Code 启动设置。
- 添加 `capture=1` 可展开内容区，用浏览器全页截图导出包含全部设置项的设计图。

## 视觉方向

参考 awesome-design-md 中 Vercel 的中性色、细边框与排版，以及 Linear 的表面层次、紧凑导航和少量强调色。适配设置工具的阅读密度，保留浅色主题，不照搬官网营销布局。

- 字体：系统无衬线字体，技术信息用等宽字体。
- 层级：页面标题 26px、分组与行标题 12px、说明 11px。
- 间距：4px 基准；内容区 44px，卡片内边距 20px。
- 形状：应用窗口 14px、分组 10px、控件 6px。
- 配色：近白/炭灰表面，低对比度边框，紫色用于选中态与开关。
- 导航：独立应用栏、设置分类、内容三级结构；窄屏分类横向滚动。

参考文档：

- https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/vercel/DESIGN.md
- https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md
