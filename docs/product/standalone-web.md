# 独立 Web 应用

Web 与 Codex Desktop 在同一仓库开发，浏览器通过 `packages/web-server` 的独立 Node 服务访问。默认 `codexhost` 会话来源连接已经运行的本地 CH Host，复用 CH 的 Thread 目录、创建、读取和操作；不直接读写 Mapping Store、不启动第二份 Adapter，也不登记 Desktop 进程所有权。显式 `--session-source standalone` 保留独立 Harness 插件模式。Web/PWA 共用响应式界面；尚无 iOS/Android 原生封装。

## 代码与构建

- `packages/adapters/*`：唯一的 Harness 接入实现。既有插件保持当前 CH 源码；`packages/adapters/codex` 是迁入的独立 Codex app-server Adapter，不改变 Desktop 原生 Codex 路径，也不加入 Desktop 预装清单。
- `packages/web-server`：Web 会话存储、HTTP/WebSocket、交互关联、Harness 事件到 DSH 界面协议的投影、认证与 Web Push。
- `apps/web-ui`：从 DSH 衍生的浏览器界面、Cordis 浏览器运行时与协议源码；仅保留所选界面依赖，来源和许可见其 README。未迁入 DSH CLI、独立 Agent Loop、原仓库 CI 或 Git 历史。

仓库统一使用 npm Workspace 和 `package-lock.json`。Web 消费公共插件上下文与命令类型；现有会话投影仍使用结构化类型子集，并不是新的 Harness 专属实现。旧 DSH 协议字段 `provider` 在本应用中携带 Harness ID，不表示 Model Provider。

```sh
npm ci
npm run build:web
npm run start:web
# 3180 已有旧 Web 服务时，不重启 Desktop；改用另一端口：
npm run start:web -- --port 3181
```

`build:web` 编译当前工作树的 CH 包并调用已有插件构建器，随后编译前端和打包。插件输入为 `packages/host-runtime/dist/plugins`，不是已安装的 CH.app 或另一个仓库。用量统计专用插件不作为聊天 Harness；Web 另行打包同仓库的 Codex Adapter。

发行目录为 `packages/web-server/dist/codexhost-web`，包含 Node 服务、Web 界面和自包含 Adapter。整体目录可以移动到仓库外运行，无需源码目录或仓库的 node_modules。显式 standalone 模式无需 CH.app 或 Codex Desktop；默认共享模式仍需要已经运行的 codexhost Desktop Host。Harness CLI 和其认证仍由用户安装、配置。

## 共享 CH 会话来源

默认启动查询现有 Desktop 中的版本化 `__codexhostHostRoutingV1`，通过已安装的本机 CDP 控制通道访问 `local` Host 的现有请求接口，不重新注入 Renderer、不修改 CH、不启动/重启 Desktop。自动发现只读取现有 Codex 进程的调试端口参数；也可传 `--ch-cdp http://127.0.0.1:<port>`。Windows 当前要求显式端点。Host 离线时报告不可用，不自动转为独立模式。

只展示 `modelProvider: codexhost` 且 Host 确认属于 external 的 Threads，包括已归档记录；不接入官方 Codex Threads或远程 Hosts。会话身份保持 CH Thread ID；列表、完整历史、模型和权限均从同一个 Host 查询。Web 不新增会话索引、原生引用映射或历史文件，DSH 格式只作可丢弃的内存展示缓冲。列表按普通刷新/定时查询更新，打开的历史按快照查询更新，没有新增持久同步队列或重放协议。首次目录通过 `session/list` 一次性返回；后续每 10 秒查询只广播实际新增、修改、移除的条目，不将未变化的全部 Threads 重发为 `api-session/added`。比较覆盖标题、执行目录、更新时间、运行状态、父 Thread 和 Harness 归属；历史/模型/权限投影仍走独立控制流。快照查询失败不推进已发布目录基线，普通列表请求与定时刷新共用同一差量发布路径，避免会话数量较多时事件洪泛阻塞切换与历史帧处理。

### 历史首屏与按需分页

按已核实的 Codex 本地分页路径，首次打开先通过 `thread/read(includeTurns: false)` 读取元数据，再请求 `thread/turns/list` 的最新 **5 轮**（`sortDirection: "desc"`、`itemsView: "full"`），按时间顺序显示；不等待全部历史，不调用 `thread/resume`，也不把工具/推理内容裁成摘要。Thread 归属由列表的 ownership 查询确认，运行态检查、模型与权限配置异步补入，不阻塞正文。

首屏 snapshot 发出后，仅后台预取 **1 页**较早历史，不自动全量遍历。用户向历史顶部滚动、接近顶部 240px 时自动通过 CH 原生 cursor 补一页，无须点击“加载更早”；滚轮、触摸上翻以及真实向顶部的滚动共享同一分页入口。短页即使尚不足一屏，也能由向更早方向的触摸/滚轮意图触发。初次打开、布局变化或程序恢复滚动位置不会自动遍历旧历史；嵌套工具滚动区和输入框不抢占外层分页。加载中显示轻量状态，复用原有阅读锚点；同一边界不重复请求。失败保留已显示内容并提供“重试加载”，继续滚动不会形成自动重试循环。前台与预取共用在途请求，失败不推进 cursor。头部刷新与旧页请求独立执行，慢旧页不阻塞新消息。重新打开复用已加载窗口，不因多客户端打开而继续后台遍历。

为兼容现有 Web 事件协议，内存展示日志使用从 `2 ** 40` 起始的非负局部序号/Turn 坐标，向前插入时向小序号扩展、向后追加时递增；它们不是原生 Turn 编号，不持久化、不传给 CH、不代表未加载的消息数。旧页插入不重编号现有消息、工具引用或滚动锚点；范围耗尽明确报错。独立模式持久日志仍从零开始。界面复用原有消息组件、折叠工具详情和分页滚动锚点，不复制 Codex 私有渲染器或状态存储。

空闲窗口的普通读取最多 30 秒直接复用；列表检测到更新时间/运行状态变化时提前校验。校验先读取轻量元数据；未变化的空闲历史避免重复拉取正文，每 60 秒仍校验一次最近 5 轮，以覆盖 Host 更新时间秒级精度内的变更。运行中读取最近页；如果新增轮数超过 5，继续读到已知尾部，避免中间漏轮。Web 写操作后强制刷新。重复 cursor、跨页重复 Turn、历史回滚导致原尾部消失均报错，不伪造连续性。当前仍为快照查询而非完整 Host 实时事件订阅；同一秒内的外部修改若未改变 Host 更新时间和观察到的运行状态，最迟在后续尾页校验中检测，不保证立即同步。所有历史缓冲仍仅在内存中。

新会话在发送前只是浏览器草稿，Harness/模型/权限可选择；首次发送通过 CH `thread/start` 创建并使用其 canonical Thread ID，然后通过 `turn/start` 提交，同样保存到 CH 原有会话目录。草稿切换为 canonical ID 时仅导航仍查看该草稿的浏览器，不跳转其他客户端。创建或发送结果未知时不自动重试写操作。Web 不执行项目创建请求、不设置 `projectId`。

执行 `cwd` 不等于用户选择了项目。Web 只读 GUI 已有的本地项目目录、Thread 项目归属与未选项目标记，按实际项目根目录补齐导航条目和项目名称；已关联项目的 worktree 归到所属项目，实际执行 `cwd` 保持不变。未选项目的会话保留，但其自动生成的目录不单独列为项目；历史临时目录也不凭路径名称猜测项目。Web 明确选择并实际提交的工作区仍保留。项目元数据不可读取时报错，不回退到全部 `cwd`；仍不创建 GUI 项目、不设置 `projectId`、不执行 `mkdir`。复用已有 `workspaces.json`，旧版本误生成的导航条目仅在共享视图隐藏，不删除记录、会话或物理目录。已经失效的真实项目目录仍能显示历史入口。现有独立模式的历史文件保持原样，不自动迁入共享来源。

当前共享入口保留文本发送、停止、原生模型/权限选择及改名；需要审批的请求由现有 GUI 处理。Web 未接入共享 Host 的审批响应/实时通知、Steering 和完整子会话操作，不把这些入口包装成已经完成的实时双端同步。独立模式原有功能不受此限制。

## 会话侧栏

侧栏参考 Codex 的紧凑导航布局：弱化项目标题与时间，区分当前选中行和悬停行，保留 Harness 身份。元信息和快捷操作共用固定尾部区域，悬停、键盘聚焦或打开菜单不挤动标题；长标题停留后缓慢展开，减少动态效果时保持静止。新会话使用轻量导航行而非突出卡片。

项目分组初始显示 5 个普通会话，平铺初始显示 10 个，每次再显示 10 个；置顶、草稿、运行中、当前会话及搜索定位目标保持可见，不为定位一个旧会话展开全部历史。这是已有目录的前端展示窗口，不是 Host 目录分页；仍使用同一目录、项目归属和原生 Thread ID。箭头键移动焦点，Enter/空格打开，左右键展开/收起项目，Home/End 定位首尾；移动焦点不会预读正文。右键或 Shift+F10 打开现有操作菜单，Escape/外部点击关闭，不因鼠标短暂离开而消失。手机端显示明确的菜单按钮，主要会话行及菜单按钮至少 44px，快捷归档/置顶收进菜单以避免误触。

项目行与分组菜单的文件夹图标保留 DSH 原有的轻量 16px 版本，项目行随展开/收起切换打开/闭合造型，悬停时换为展开箭头。其他通用图标使用 OpenAI 公开的 MIT SVG 图标子集：展开箭头、新会话、搜索、视图选项、置顶、归档、改名、分叉、导入、设置及侧栏开关。保留原始 SVG 轮廓和填充规则，随当前文字颜色适配主题。只引入必要 SVG 数据，不引入整套 Apps SDK，不打包私有 Desktop 动画资源；公开版本的个别字形与当前 Desktop 私有版本并非逐像素相同。Harness 品牌、权限含义及真实状态不替换为 Codex 身份，远程图标/连接状态也不凭截图伪造。版权与许可文本随 Web 发行打包。

状态继续来自已有投影；未接入的原生审批/未读能力不伪造。正文通用运行文案使用“正在处理 / Working”，不暗示某个 Model、推理模式或深度研究能力。

## 对话轮次导航

正文左侧的轮次导航参考已安装 Codex 的 `thread-user-message-navigation-rail` 与 `floating-navigation-rail-layout` 行为实现：距离正文滚动区左边缘 12px、每项间距 10px；根据正文实际左侧留白判断，少于 48px 时隐藏，不挤占窄屏内容。平时为短刻度，当前阅读轮次加深；悬停目标及相邻三项按距离依次加长。预览向右展开，限制一行提问和三行回复，悬停短暂延迟后出现，键盘聚焦立即显示。

点击沿用 Web 的语义锚点跳转；按住拖动可连续定位已加载消息，松开不会跳回起点，也不会为拖动经过的未加载项发起大量历史请求。导航本身可独立滚动并显示边缘淡出，不触发正文自动加载；保留键盘操作和减少动态效果偏好。标签按导航项位置编号，不暴露内存日志的内部坐标。导航仅呈现已有窗口/outline 中已知的项目，不为构建导航全量读取原生历史。未添加 Codex 的书签、音频可视化或其私有状态存储。

## Harness 与 Model 选择

Composer 的模型/推理等级控件旁提供独立的 Harness 图标按钮。菜单沿用 Desktop 的“图标、Harness 名称、当前勾选”方式；图标来自插件资源，不从 Model Provider 名称推测。就绪插件可选，检查失败的条目标记为不可用。

新会话可切换 Harness；选择时采用该 Harness 目录的首个可用 Model 及其默认推理等级，随后可单独选择其他 Model。模型菜单和 `/model` 只列当前 Harness 的模型。两个控件共用原来的目录、`session/selectModel` 和确认后的持久投影，不维护另一份选中状态。

会话有原生历史后固定 Harness；菜单仍展示其他 Harness，但禁用切换并提示新建会话。当前 Harness 内的 Model 选择保持可用。重新连接或刷新按持久投影恢复，不把现有 Native Session 迁到另一个 Harness。

## 原生权限与会话标识

权限菜单及 `/permission` 读取当前会话的 Adapter 权限目录，保留原生模式 ID、标签、描述与危险标记；不再把 `auto` 解释成 DSH 的 Auto review，也不使用进程全局权限目录为不同 Harness 套用相同预设。危险模式有显式确认；无原生可选权限能力的 Harness 隐藏入口。`atCreate` 模式仅在原生会话创建前可选，之后锁定；原生拒绝显示错误，不伪造切换成功。未打开原生会话时保存所选 ID并在 `Adapter.open` 时传入，已有会话通过 `permissionMode.select` 下发。跨 Harness 的草稿切换恢复目标 Harness 原生默认值，不继承同名模式的语义。全局默认权限设置入口不再显示，因为各 Harness 的模式与生效范围并不相同。

左侧会话行读取服务端持久元数据中的绑定 Harness（草稿读取该会话的已选 Harness），显示插件品牌图标，不从当前 Composer 或其他会话的默认选择推测。未打开的历史会话同样显示，刷新可恢复；运行、审批和未读状态叠加在图标旁，归档保留身份。缺少图标资源时使用通用图标，不伪造其他品牌。

## 并发运行与预览

`start:web` 固定监听 localhost 并保留访问令牌认证，默认连接已有本地 CH Host。独立模式通过 `--session-source standalone` 显式选择；其预览默认只启用 Claude Code。服务子进程不继承 `CODEXHOST_*`、`NODE_OPTIONS` 或 `NODE_PATH`。预览默认数据目录为 `~/.codexhost-web-preview`，工作区为 `~/codexhost-web-preview-workspace`；支持 `--port`、`--data`、`--workspace`，以及逗号分隔的 `--harness <id,...>`。默认仅 Claude Code；`npm run start:web -- --harness all` 启用本发行包除 Codex、Pi 和用量统计专用插件外的所有会话插件。显式选择 Codex/Pi、缺失插件或用量统计插件会在启动前报错。

启用插件不等于机器已安装、认证对应 CLI，也不等于所有能力已完成 Web 验收。模型菜单只列检查就绪的 Harness；未安装的不会列为可用，检查失败由目录接口报告。Codex、Pi 的独立启动入口仍未验证，隔离预览始终拒绝启用；其他插件所需的可选 Host 上下文以及完整界面能力也需逐项验收。不要从 CH 承载的 Agent 会话直接启动继承原环境的 `server.mjs`，也不要把 Desktop 的环境变量恢复到预览进程。

Web 和 Desktop 可以共享 CLI 安装及登录账号，不应同时恢复并写入同一个 Native Session，也不应让两个 Agent 同时修改同一工作目录。Web Host 元数据独立，不意味着原生 Harness 会话文件或账号额度隔离。

## 验证与限制

```sh
npm run typecheck
npm run test:web
npm run test:web:distribution
npm run test:web:browser
npm run test:sidebar --workspace=@deepseek-ai/dsh-client-ui-workspace
```

服务端和浏览器测试使用假 Harness、模拟 CH Host/CDP 与临时数据，不提交真实模型请求。共享来源检查覆盖 canonical 身份、已有 GUI 历史、Web 创建、自动目录分组和不新增会话文件；真实环境仅进行目录/元数据和页面只读检查。浏览器检查覆盖手机尺寸的设置、主题持久化、发送、断网重连和历史恢复；发行检查覆盖仓库外运行、插件资源和隔离启动参数。迁入的 Codex Item 映射测试由仓库 Vitest 配置运行。

CH 与 Web 后端纳入现有 TypeScript 检查；迁入前端由 tsdown/Vite 编译并接受浏览器回归，原 DSH 的完整前端类型检查与测试配置尚未迁入。自动化浏览器尺寸测试不替代真机键盘、后台生命周期和 HTTPS Web Push 验收。图片/附件仍被明确拒绝；没有把文件路径伪装成图片支持。
