# codexhost Web · 保留结构的移动适配

**不是另一套移动产品。** 原型以当前 Web 的侧栏、会话流、Composer、设置浮层为基准，调整窄屏容器、触控尺寸、键盘适配与苹果式磨砂材质，并在会话顶部新增「最近访问」快捷切换提案。

**配色沿用现有 Web，不新增移动端色调。** 当前浅色原型采用 `design-platform.css` 的白色背景、近黑正文、原有用户消息气泡色；磨砂不额外染色或增强饱和度。正式接入需继承现有明暗主题，并限制在移动适配范围，桌面主题与布局不变。本原型没有实现暗色主题，也没有修改正式 Web。

## 浏览

- 本地服务：**http://127.0.0.1:8080/**，刷新即可查看。
- [index.html](index.html)：页面切换、390 / 430 宽度切换、**磨砂玻璃 / 实色对照**。
- [app.html#thread](app.html#thread)：直接进入会话，适合手机浏览。
- 可以直接打开静态文件；不需要构建、安装依赖或访问 Host。
- `?preview=1` 只为截图加入模拟状态栏和 home indicator。真实手机直接打开 `app.html`，使用真实安全区。

## 侧栏：紧凑会话与原有入口

会话列表标题行保留「搜索、视图选项、添加工作区」三个独立入口，不合并到更多菜单。

- 会话统一 48px 单行，标题为 14px，不增加状态第二行。右侧沿用现有 Web 的加载指示器、状态点和「待审批 / 待回答」短文案；普通时间在触控端和模拟手机预览中隐藏。完整状态与示例更新时间仍可从会话详情和可访问名称读取。
- 状态表达依据 `ui-workspace/src/client/rows/Rows.tsx` 与 `ui-primitives/src/StateDot.tsx` / CSS。Host 连接中断保留在 Composer 与详情中，不新增任务状态点；样本未模拟完成未读提醒，不从“已完成”推断未读。
- 左侧使用仓库中对应 Harness 的图标，右侧显示原有状态指示；非触控端空闲时显示示例更新时间。选中态是轻底色，不为每条会话叠玻璃卡片。每行独立的 44px「⋯」按钮可打开完整标题和会话信息，演示打开、置顶 / 取消置顶、归档 / 恢复；按钮与会话链接互为兄弟，不嵌套交互控件。
- 视图选项在同一个抽屉内展示：按工作区 / 工作区树 / 单列表，手动顺序 / 最近更新，隐藏 / 包含 / 仅显示已归档。选择即时作用于示例侧栏；顶部最近访问不受影响。手动顺序与更新顺序都是固定样本，不模拟拖拽或真实消息更新。
- 搜索按需展开，匹配标题和工作区，并遵守归档筛选；显示归档时列表顶部保留筛选提示。Escape 逐层返回，先退出详情并回到可见的触发按钮，再清空或收起搜索，最后关闭侧栏。
- 添加工作区展示 **Host 电脑**的固定目录样本。已有工作区不可重复添加；选择后「添加并新建对话」进入选定工作区的新对话，当前对话草稿保留。示例工作区和新建会话会出现在侧栏，仅在页面内存中保留。
- 不访问手机文件、不枚举电脑目录、不创建文件夹、不提交 Host 请求。置顶、归档 / 恢复只改变本地示例列表，不执行真实操作，也不自动批准或回答会话中的请求。

入口：[侧栏](app.html#threads) · [视图选项](app.html#view-options) · [添加工作区](app.html#add-workspace)。旧的 `#sidebar-more` 链接兼容打开当前侧栏，不再显示合并菜单。

## 输入区与底部统计

- 常驻截图和语音入口；窄屏把模型名换成图标入口，≤359px 时权限可从「+」打开，不缩小点击目标。
- 底部恢复 `CH 99.9% · 36.5 tok/s · $2.31` 和上下文 `66%` 的**示例**展示。CH 是最近缓存命中率，右侧圆环是上下文已用比例，不是账号剩余额度。两者分别可点开；缺失字段隐藏，不显示为 0。
- 电脑截图 → 查看静态示例 → 附加到草稿；可演示电脑端权限失败和手动重试。截取对象是 Host 电脑，不是手机；此处不实际截屏。
- 语音入口 → 原位模拟录音 →「结束并填入」草稿，或明确选择「转写并发送」。全程不启用麦克风，不生成音频，不调用转写服务。取消、草稿修改和会话切换不会造成迟到结果覆盖或误发送。
- 原型仅演示截图预览 / 附加；实际查看器的放大、旋转、标注，语音长录音撤销和音频服务重试没有模拟。真实语音入口还需依据服务可用性与浏览器录音能力显示。

## 最近访问：体验路径

1. 在会话里展开工具活动和 diff，滚动一段距离，写下未发送草稿。
2. 左右滑动顶部最近访问栏：只浏览、不切换。点「检查 Relay…」，再点「修复移动端…」返回：草稿、附件、展开状态和阅读位置保留。
3. 点「更多」或当前会话标题：完整标题、项目、Harness、当前分支、任务状态和草稿标记集中显示；输入 `console-ui` 可体验按项目搜索。
4. 高度缩到 514px 时，快捷栏隐藏，标题仍能打开选择层。实际软键盘行为仍需真机验证。

顶部压成两行：52px 标题栏 + 48px 横滑最近访问，总计 100px（不含安全区）。最近访问最多六个其他会话，单行标题不重复项目名，边缘露出下一项；右侧「更多」固定，超过六项进入选择层查找。使用原生触摸滚动和轻量吸附，滑动不触发切换。同名标题在快捷项前加入项目名。访问顺序只由用户切换和实际创建对话改变，不随后台消息或审批状态更新。侧栏仍负责项目浏览；它的「最近更新」不是这里的「最近访问」。

边界预览：[无访问记录](app.html#recent-empty) · [仅一个会话](app.html?history=single#thread) · [空记录的新对话](app.html?history=empty#new)。记录只在当前页面内存中，默认预置六条示例访问记录，刷新重置。

## 保留什么，适配什么

| 现有 Web 结构 | 原型处理 |
| --- | --- |
| 左侧项目 / Thread 分组、新对话、底部设置入口 | 保留为左侧抽屉，不新增列表主页或底部 Tab |
| 顶部打开侧栏、新对话、会话标题、文件入口 | 保留顺序；标题打开最近访问及项目 / 分支详情，下方原生横滑快捷栏，触控目标至少 44 px |
| 用户消息、Agent 消息、工具活动、代码变更 | 保留单列消息流；工具折叠，diff 原位展开 |
| Composer 中附件 / 指令、截图、语音、权限、模型、Harness、发送 | 输入为 16 px，适应可视视口；图标与菜单承接窄屏溢出 |
| Composer 下方统计 | 用量摘要和独立上下文圆环可点击；示例数据，不伪造未知数值 |
| ApprovalPanel 接管 Composer | 原位磨砂操作面板，不跳页、不强制打开模态窗 |
| 设置浮层及手机横向分类 | 保留分类，不合并成手机专用设置页 |
| 新对话欢迎区与工作区选择 | 保留“今天想做点什么？”与同一个 Composer |
| 文件右侧面板 | 窄屏覆盖显示，关闭后回到原会话 |

磨砂只用于控制层：导航、侧栏、Composer、审批区和浮层。消息、代码仍为清晰实底。滚动时内容从控制层下面经过；实色对照使用完全相同的 DOM 与布局。

**观察材质：** 先打开项目侧栏，观察消息在下面形成的软轮廓；再在代码变更上打开侧栏，观察 diff 的色彩透底。Composer 使用 24% 底色 / 14px blur，侧栏 34% / 18px，设置 62% / 24px。没有彩色壁纸或伪造背景；空白处的材质自然更安静。导航背景独立渐隐，前景文字始终清晰。

## 可点击视图

| 链接 | 展示内容 |
| --- | --- |
| [#thread](app.html#thread) | 默认会话、最近访问快捷栏、工具活动与文件变更 |
| [#recents](app.html#recents) | 最近访问选择层：完整标题、项目、状态、草稿、搜索 |
| [#recent-empty](app.html#recent-empty) | 无访问记录，引导到侧栏 |
| [#threads](app.html#threads) | 单行会话条目、原有右侧状态、搜索 / 视图选项 / 添加工作区 |
| [#view-options](app.html#view-options) | 分组、排序与归档筛选示例 |
| [#add-workspace](app.html#add-workspace) | Host 目录选择与添加后新建对话演示 |
| [#composer](app.html#composer) | 多行后续消息、截图 / 语音与输入工具栏 |
| [#usage](app.html#usage) | 缓存命中率、输出速度、费用估算示例 |
| [#context](app.html#context) | 上下文占用与容量示例 |
| [#screenshot](app.html#screenshot) | 电脑截图预览、附加、权限失败 / 重试演示 |
| [#voice](app.html#voice) | 原位语音输入演示，不启用麦克风 |
| [#voice-error](app.html#voice-error) | 麦克风权限失败与重试演示 |
| [#approval](app.html#approval) | Composer 原位审批：命令、目录、拒绝、允许一次 |
| [#question](app.html#question) | Composer 原位问题与设备选项 |
| [#settings](app.html#settings) | 原设置分类与通用设置样例 |
| [#harness](app.html#harness) | 新对话的 Harness 选择 |
| [#new](app.html#new) | 新对话欢迎区 |
| [#empty](app.html#empty) | 未选择工作区的空状态 |
| [#error](app.html#error) | 会话内连接错误、保留草稿与重试 |
| [#diff](app.html#diff) | 会话中展开的统一 diff |
| [#files](app.html#files) | 文件右侧面板 |

可尝试：打开侧栏 → 搜索 / 选择 Thread → 展开工具活动和 diff → 添加示例附件 → 写后续消息；或新对话 → 选择 Harness → 发送。已创建 Thread 的 Harness 保持固定。

## 当前实现的对照依据（只读）

- `apps/web-ui/packages/client/ui-layout/src/client/AppFrame.tsx`、`AppFrame.module.css`：手机侧栏抽屉与主区域。
- `ui-sidebar/src/client/SidebarRoot.tsx`、`ui-workspace/src/client/rows/WorkspaceBrowser.tsx`：侧栏入口、项目分组与搜索。
- `ui-workspace/src/client/tree.ts`：现有「最近」按 `updatedAt` 排序，位于项目分组之后；新增的访问顺序不是对这个字段的改名。
- `ui-conversation/src/client/skeleton/ConversationHeader.tsx`、`InputBar.tsx`、`InputBar.module.css`：导航与 Composer 工具行。
- `ui-approval/src/client/ApprovalPanel.tsx`：审批接管 Composer。
- `ui-codexhost/src/client/HostUsageDock.tsx`、`ui-conversation/src/client/skeleton/ContextMeter.tsx`：用量摘要与上下文占用，额度与上下文不是同一数据。
- `ui-codexhost/src/client/DesktopScreenshot.tsx`、`VoiceInput.tsx`、`voice-input.ts`：电脑端截图、当前设备录音及安全的草稿插入语义。
- `ui-settings-general/src/client/SettingsRoot.tsx`、`SettingsRoot.module.css`：设置浮层及手机横向分类。
- `ui-model-selection/src/client/HarnessSelect.tsx`：已有 Thread 绑定 Harness。
- `ui-codexhost/src/client/index.ts`、`locales.ts`：设置分类注册与文案。
- `ui-theme/src/styles/design-platform.css`、`ui-chat/src/client/chat/MessageItem.module.css`：现有页面、正文、用户消息与交互颜色；原型静态取值，不跨目录加载生产 CSS。

后续缩写路径均相对于 `apps/web-ui/packages/client/`。这是基于源码的高保真适配提案，不是已登录 Web 页面的像素级复刻；运行中的 Web 需要访问令牌，本次没有绕过认证或读取令牌。

## 原型边界

- 数据、模型列表、命令、diff、截图、转写文字、连接状态均为**示例**；不执行命令、不发送到 Host、不上传文件、不修改配置。
- 只保存当前页面内的演示状态，刷新重置。切换保留草稿、附件、消息、模型、展开内容和阅读位置；不写 localStorage。新建演示使用独立 ID，不覆盖先前新建的任务。
- Harness 和 Model 分开选择；已有 Thread 中其他 Harness 禁用。权限说明不被当成跨 Harness 的统一权限配置。
- 设置“通用”展示交互，其余分类保留导航与范围说明，没有伪造完整管理功能。“界面材质”明确标为原型预览，不声称是现有产品配置。
- 文件与导入入口仅展示结构；不读取用户文件或真实会话。错误重试固定返回演示失败，不自动重发。

## 技能规则

- **Impeccable / adapt**：Operate 模式；优先现有结构和扫描效率；44 px 操作目标；无 hover-only 入口；按需展开工具与代码。
- **Apple design**：磨砂承载实际控制层，白色高光边与柔和阴影表达厚度；按下立即反馈；抽屉 / sheet 可中断弹簧、直接跟手和边界阻尼；不做装饰性光斑或全屏动效。
- **Mobile native**：`100dvh`、四侧安全区、`VisualViewport`、16 px 输入、允许缩放、内层滚动隔离、能力查询限制 hover、减少动态与减少透明度降级。

## 验证与截图

Chromium 检查涵盖 320×844 / 390×844 / 430×844 布局、按钮尺寸、侧栏搜索、原位 diff、文件侧栏、草稿、附件、发送、新建与绑定 Harness、审批接管、问题回答、未选工作区、重试和设置 / 材质切换。截图 / 语音 / 数据检查包括字段缺失、上下文含义、截图失败 / 重试、附件发送、切换保留、转写填入与发送的区别、草稿冲突、切走再切回、取消迟到结果、权限重试，以及无真实 API / 媒体调用。最近访问还检查了合成触摸左右滚动不误触切换、100px 顶栏、切换往返恢复、当前会话不跳页、搜索无结果、零 / 一 / 多条记录、独立新建会话与模型保留、审批状态不重排、矮屏标题入口。没有运行生产构建或全量测试。

侧栏交互检查覆盖三种分组、两种排序、三种归档筛选、搜索与空结果、逐层 Escape / 焦点返回、添加工作区防重复、新建会话入列及原草稿保留；确认视图选项不重排最近访问且没有 API 请求。条目调整后的 8 个相关视图 × 320 / 390 / 430px 检查无横向溢出、无 JavaScript 错误，交互目标至少 44px；当前会话行统一为 48px，已检查无状态副行、右侧待处理短文案 / 加载指示器、触控隐藏普通时间与精确指针保留时间。验证了图标加载、链接与操作按钮分离、置顶 / 归档 / 恢复、状态交互结束后移除右侧待处理提示、焦点返回及减少动态 / 高对比度降级；514px 高度可滚动到详情操作。`previews/sidebar-controls.png` 为当前侧栏 / 视图选项 / 添加工作区对照，`sidebar-items-comparison.png` 为条目优化前后对照，`sidebar-items.png` 展示列表、行内操作和归档筛选。

配色检查覆盖 19 个视图 × 320 / 390 / 430px：页面底色与正文对应现有 Web 浅色值，磨砂滤镜仅保留 blur，不增强饱和度；没有文档横向溢出或 JavaScript 错误，实色 / 磨砂切换不改变 Composer 几何尺寸。已更新当前截图和电脑截图演示样本。

材质检查还验证：改变下层真实消息会改变磨砂截图，而实色截图不变；减少透明度 / 高对比度设置关闭背景模糊；降低不透明度后加深辅助文字以保持可读性。背景抽样仅覆盖示例内容，不代表任意背景都满足对比度。

没有重复运行本会话的机械设计扫描；新增交互使用聚焦浏览器检查和渲染复核。配色以现有 Web 为依据，紧凑标题层级和 11 px 辅助信息为保留现有专业工具密度的选择；不宣称扫描零告警。

`previews/` 包含各视图 390 px 截图、430 px 宽度检查、受限高度 Composer、目录页、`overview.png` 六屏总览、`composer-capabilities.png` 统计 / 截图 / 语音对照、`recent-switching.png` 快捷切换 / 选择层对照，以及 `material-comparison.png` 同布局材质对照。

`material-before*.png` 和 `material-*-before-after.png` 是历史材质实验，包含不采用的暖白 / 深蓝配色；`material-before-after.png` 同样不是当前配色，且未包含最近访问入口。`sidebar-items-before-390.png` 是双行条目历史基准，`sidebar-items-comparison.png` 左侧保留该基准用于比较。其余视图展示当前原型。所有图片均为静态示例渲染，不是实际产品截图。

WebKit 浏览器未安装，本地验证使用 Chromium。**仍需真机验证：** iPhone Safari 的软键盘、安全区、触控滚动和弹簧手感；VoiceOver、Dynamic Type。浏览器尺寸与合成指针测试不能代替硬件验证。设计复核在本会话内完成，未使用独立审阅代理。

## 文件

- `app.html` / `styles.css` / `prototype.js`：静态移动原型。
- `sidebar-controls.js`：侧栏内的搜索、视图选项和工作区样本交互。
- `index.html` / `index.css` / `index.js`：预览目录与对照工具。
- `DESIGN.md`：材质、尺寸、运动与结构约束。
- `previews/`：当前版本截图及注明的历史对照。
- `assets/sample-desktop.png`：取自原型评审页的固定截图样本，非实际电脑桌面。
- `assets/harness-*`：对应 Adapter 的图标样本；Pi 使用其 manifest 的 vector presentation。只用于静态预览，不从 Host 加载。

所有修改仅在 `design-prototypes/web-mobile-v1/`；生产代码未改，未提交 Git。
