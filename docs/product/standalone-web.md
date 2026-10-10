# 独立 Web 应用

Web 与 Codex Desktop 在同一仓库开发，浏览器通过 `packages/web-server` 的独立 Node 服务访问。默认 `codexhost` 会话来源按需启动或连接独立的本地 CH 后台，复用 CH 的 Thread 目录、创建、读取和操作；Web 网关不直接读写 Mapping Store、不启动第二份 Adapter，也不登记 Desktop 进程所有权。显式 `--session-source standalone` 保留独立 Harness 插件模式。Web/PWA 共用响应式界面；尚无 iOS/Android 原生封装。

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

`build:web` 编译当前工作树的 CH 包并调用已有插件构建器，构建原生 Launcher，随后编译前端和打包。插件输入为 `packages/host-runtime/dist/plugins`，不是已安装的 CH.app 或另一个仓库。用量统计专用插件不作为聊天 Harness；Web 另行打包同仓库的 Codex Adapter。

发行目录为 `packages/web-server/dist/codexhost-web`，包含 Node 网关、Web 界面、同一 Host bundle、当前平台的原生 Launcher 和自包含插件；会话与用量插件在后台显式启用，Codex Adapter 仅供 standalone。整体目录可以移动到仓库外运行，无需源码目录或仓库的 node_modules，但原生 Launcher 不能跨 OS/CPU 使用。默认共享模式也不要求 Desktop 运行：Web、Desktop 均可独立使用，同时开启时共享后台，晚开启的一端读取最新事实；关闭任意界面不停止另一端或后台任务。需要本机受支持的 Node，Harness CLI 和其认证仍由用户安装、配置。

## 共享 CH 会话来源

默认发现本地 CH 的认证客户端通道 v1；没有健康服务时，调用同仓库/发行包原生 Launcher 按需启动后台，不启动/重启 Desktop、不重新注入 Renderer。通道描述文件默认位于 `~/.codexhost/client-hosts`。`--ch-data <dir>` 指定后台数据目录，和 Web 的认证/设置 `--data` 分开；还可显式指定 `--ch-launcher`、`--ch-host-runtime`、`--ch-plugins`、`--ch-codex-home`。自定义发现路径为 `--ch-control-directory <ch-data>/client-hosts`，不能用另一个目录暗中创建不同所有者。Desktop 必须使用同一 Host 数据目录和 Codex home，才能共享原会话。

后台持有唯一存储和原生执行所有权；两端并发启动受原生锁保护，关闭前台不释放执行所有权。后台换代仅恢复原生历史与当前可读取事实，不重发写入，不保证崩溃时进行中的任务继续执行。显式维护可运行 `codexhost host stop`，该操作会停止任务；应先关闭会自动重连的界面。生命周期及退出证明见[客户端通道](../architecture/host-client-channel.md)。

已运行的旧 Desktop-owned 通道仍可连接，但不会被接管或停止；迁移须用户另行更新并重启 Desktop。单独指定 `--ch-cdp http://127.0.0.1:<port>` 明确选择旧 CDP 入口；与 control directory 同用时，Thread 请求使用事件通道，CDP 仅为依赖 GUI 的原生置顶服务及旧 Host 项目读取提供入口。独立后台从原生保存文件只读读取项目，Windows 的共享聊天/项目读取不再要求 CDP。已选中的服务通道只重连或启动同一后台，不暗中换成 standalone。仅重建 Web 不会升级正在运行的后台或 Desktop。

只展示 `modelProvider: codexhost` 且 Host 确认属于 external 的 Threads，包括已归档记录；不接入官方 Codex Threads或远程 Hosts。会话身份保持 CH Thread ID；列表、完整历史、模型和权限均从同一个 Host 查询。Web 不新增会话索引、原生引用映射或历史文件，DSH 格式只作可丢弃的内存展示缓冲。事件模式按 Host 通知刷新正在订阅的历史，100ms 合并同一 Thread 的连续变化；普通历史 1.5 秒轮询不再运行。通知只表示状态失效，客户端读取最近 5 轮的权威完整状态，不直接拼接重放的 token。读取期间的新事件会安排下一次校验，不会被正在进行的读取吞掉。目录变化也合并处理；保留每 10 秒的目录/原生项目元数据查询，因为项目归属不属于聊天事件。首次目录通过 `session/list` 一次性返回；后续查询只广播实际新增、修改、移除的条目，不将未变化的全部 Threads 重发为 `api-session/added`。比较覆盖标题、执行目录、更新时间、运行状态、父 Thread 和 Harness 归属；历史/模型/权限投影仍走独立控制流。快照查询失败不推进已发布目录基线，普通列表请求与定时刷新共用同一差量发布路径，避免会话数量较多时事件洪泛阻塞切换与历史帧处理。

### 历史首屏与按需分页

首屏遵循已核实的 Codex 本地最近 **5 轮 full/desc** 路径，按时间顺序显示。事件模式由 Host 快照一次提供元数据、最近页、生效配置和待处理交互；冷历史沿用 Host 的 `thread/turns/list`，热会话从同一投影器取得包含用户输入、Reasoning、工具进展的完整状态，而不是 Desktop 专用的精简 `pendingTurn`。旧入口先读 `thread/read(includeTurns: false)` 再读最近页。两种模式均不等待全部历史、不调用 `thread/resume`，也不把工具/推理裁成摘要。Harness 能力目录异步补入，不阻塞正文。

首屏 snapshot 发出后，仅后台预取 **1 页**较早历史，不自动全量遍历。用户向历史顶部滚动、接近顶部 240px 时自动通过 CH 原生 cursor 补一页，无须点击“加载更早”；滚轮、触摸上翻以及真实向顶部的滚动共享同一分页入口。短页即使尚不足一屏，也能由向更早方向的触摸/滚轮意图触发。初次打开、布局变化或程序恢复滚动位置不会自动遍历旧历史；嵌套工具滚动区和输入框不抢占外层分页。加载中显示轻量状态，复用原有阅读锚点；同一边界不重复请求。失败保留已显示内容并提供“重试加载”，继续滚动不会形成自动重试循环。前台与预取共用在途请求，失败不推进 cursor。头部刷新与旧页请求独立执行，慢旧页不阻塞新消息。重新打开复用已加载窗口，不因多客户端打开而继续后台遍历。

为兼容现有 Web 事件协议，内存展示日志使用从 `2 ** 40` 起始的非负局部序号/Turn 坐标，向前插入时向小序号扩展、向后追加时递增；它们不是原生 Turn 编号，不持久化、不传给 CH、不代表未加载的消息数。旧页插入不重编号现有消息、工具引用或滚动锚点；范围耗尽明确报错。独立模式持久日志仍从零开始。界面复用原有消息组件、折叠工具详情和分页滚动锚点，不复制 Codex 私有渲染器或状态存储。

旧 CDP 入口保留 30 秒空闲复用、60 秒最近页校验及 1.5 秒运行历史查询。事件模式每次打开和重连均读取权威快照，不依赖秒级 `updatedAt` 变化；Host/网关使用有界内存事件窗口、epoch 和递增序号恢复通知。窗口不足或 Host 换代时重新读取，已显示正文保留，连接状态显示“正在重连”。新增轮数超过 5 时继续读到已知尾部，避免漏轮。重复 cursor、跨页重复 Turn、原尾部消失或已显示流式正文被改写仍明确报错，要求重新打开历史，不伪造连续性。所有历史缓冲均仅在内存中；v1 是事件驱动的绝对状态收敛，不是逐 token 差量协议，长工具输出的快照传输仍有优化空间。

新会话在发送前只是浏览器草稿，Harness/模型/权限可选择；首次发送通过 CH `thread/start` 创建并使用其 canonical Thread ID，然后通过 `turn/start` 提交，同样保存到 CH 原有会话目录。草稿切换为 canonical ID 时仅导航仍查看该草稿的浏览器，不跳转其他客户端。创建或发送结果未知时不自动重试写操作。Web 不执行项目创建请求、不设置 `projectId`。

执行 `cwd` 不等于用户选择了项目。Web 通过后台只读 GUI 保存在 `CODEX_HOME/.codex-global-state.json` 的本地项目目录、Thread 项目归属与未选项目标记（旧 Host 沿用 CDP），按实际项目根目录补齐导航条目和项目名称；已关联项目的 worktree 归到所属项目，实际执行 `cwd` 保持不变。未选项目的会话保留，但其自动生成的目录不单独列为项目；历史临时目录也不凭路径名称猜测项目。Web 明确选择并实际提交的工作区仍保留。项目元数据不可读取时报错，不回退到全部 `cwd`；仍不创建 GUI 项目、不设置 `projectId`、不执行 `mkdir`。复用已有 `workspaces.json`，旧版本误生成的导航条目仅在共享视图隐藏，不删除记录、会话或物理目录。已经失效的真实项目目录仍能显示历史入口。现有独立模式的历史文件保持原样，不自动迁入共享来源。

共享入口保留文本及图片路径附件发送、停止、原生模型/权限选择及改名。事件模式下，同一 Thread 的 GUI/Web 消息、普通工具进展、生效配置、审批和提问共用 Host 状态。Web 使用原生选项呈现交互，Host 校验并接受第一份有效响应，再通知其余端关闭；断线时撤下交互，重连只恢复仍待处理的请求，不因取消本地卡片而自动回答 Harness。Web/App 发出的用户输入也通过既有 Host 投影广播给 GUI，原生 `clientId` 用于撤下 Web 的乐观回显。已确认发送不会因随后读取失败变成“发送被拒绝”；连接中断导致结果未知时不自动重发。`turn/start` 的请求 ID 去重仅覆盖当前 Host 进程最近 256 条回执，不承诺跨重启或超窗口 exactly-once。同时发送遵循原有 Harness/Host 忙碌规则，不另开会话并行执行。

通用 App 可通过 Web 原有认证访问 `/api/ch/v1/{events,rpc,snapshot,respond}`，不需要理解 DSH 渲染日志，也拿不到 Host 私有 token。协议、恢复顺序和部署边界见[客户端通道](../architecture/host-client-channel.md)。本地草稿、滚动位置和当前选中会话不共享。旧 CDP 模式的审批仍在 GUI 处理；共享 Web 的通用文件预览/下载、Steering、完整子会话/后台任务投影仍有边界。公开远程 Host 通道、原生 App、真机后台与推送生命周期不在本次接入内。

### 附件：落盘后沿用原生路径上下文

本地共享模式支持 PNG/JPEG/WebP/GIF 的粘贴、文件选择及拖放；图片先在浏览器草稿中预览，只有点击发送才上传。服务端验证整批图片后，将收到的原始字节保存到 `<--data>/attachments/images/<sha256>.<ext>`，目录/文件默认权限为 0700/0600，不使用用户文件名或路径作为落盘位置。内容寻址用于去重与完整性校验，不建立新的 Thread 索引。

转交 Host 的仍是文本输入，沿用 Desktop/CH 的 `# Files mentioned by the user:`、绝对文件路径、`Image attachment: true`、附件指令隔离提示和 `## My request:` 上下文；不是把 base64 发给 Harness，也不是扩展 Harness 的图片协议或声称所有 Model 支持视觉。Harness 是否能读取该路径、是否需要审批以及如何理解图片，仍由其原生工具、权限和 Model 能力决定。适用范围是 Web 与本地 Host 共用文件系统；不将本机路径冒充 SSH/远程/WSL 执行环境中的路径，也不修改 Codex 配置文件。

限制为每张 20 MiB、每条消息 20 张/合计 32 MiB、单边 8192 像素、总像素 6400 万；只检查受支持栅格格式的签名和头部尺寸，不转码或压缩。RPC 请求在解析前限制为 48 MiB（包括 base64/JSON 开销），保留原有认证及同源校验。非法上传在分配原生 Thread 前拒绝。`image-size` 仅用于头部尺寸检查，其 MIT 许可随发行包保留。

共享消息的执行输入与展示分开：`ChAttachments` 从完整的原生文件上下文及 `## My request:`（兼容 `for Codex`）拆出用户正文、标记为图片的引用和普通文件卡片；支持任意原生文件标签、行号及 quoted pasted-file 标签，不要求 Web 的 `image-N` 或 SHA256 命名。普通路径提及、代码示例及不完整/未知上下文仍保持原文，不误删用户 Markdown。结构化 `localImage`、`image` 的 data/file URL 使用同一图片展示入口，优先于冗余的序列化附件信息，不重复显示图片。原生普通文件卡片呈现名字/路径，不读取其内容或假造大小；本 Web 上传的文件卡片显示其实际名字和字节数。历史展示不开放任意文件下载或自动解析文件预览。执行文本及 CH 的原生历史不被改写，界面仍使用 DSH 的既有组件。

`session/attachment` 同时核对当前 external Thread 已加载原生用户消息中的图片来源和其内存展示引用；native `ch-image` ID 不携带可由客户端解码的路径，并按 Thread 隔离。读取接口不接受浏览器传入的路径、标签或元数据作为授权；猜测 ID、其他 Thread 的引用、工具输出和正文中的普通路径不能取得文件。原生本地图片（包括 `codex-clipboard-<UUID>` 临时文件和原始文件路径）在其原位置只读访问，不复制到 Web 数据目录，也不新增持久图片映射。Web 自有文件仍按 SHA256 校验；原生文件在当前展示窗口中捕获内容指纹，读取时变化则拒绝。刷新、Web 重启及较早分页均从 CH 历史重建引用；尚未加载的旧页不会授予读取权限。

本地文件读取拒绝路径遍历、符号链接（包括附件路径内的目录链接）、非普通文件和超限图片；仅容许系统 temp/home 根目录的已知真实路径别名。读取有字节上限并检查过程中大小/修改时间的变化。服务端不抓取 HTTP/HTTPS、app/blob 或远程 file URL，避免图片预览变成任意下载/SSRF 接口。文件缺失、无法读取、不支持、超限或浏览器解码失败时保留用户正文并显示“图片不可用，点击重试”，不回退展开整段执行上下文，也不使整个历史失败；明确重试可恢复后来重新可读的图片。不转换 SSH/WSL/远程路径，不修改 Codex 配置或附件文件。

已建立会话的发送被拒绝时保留图片草稿；提交结果未知时不自动重发，也不删除可能已被 Native Session 引用的图片。Web 上传的文件保留在数据目录，不自动随会话删除；手动清理会使历史预览失效。原生临时文件仍遵循原生生命周期，Web 不保证其长期保留。

本地共享入口也支持任意类型的普通文件（TXT/PDF/Office/ZIP/未知扩展名等），不做 MIME 或扩展名白名单，不解压、转码或执行文件。选择或拖入后沿用 DSH 后台上传及进度/重试/移除组件；上传完成前不能发送。原始字节以流式方式写入 `<--data>/attachments/files/<sha256>/<安全文件名>`，保留常规扩展名及 Unicode 名字，清理路径分隔符、控制字符与平台保留名；目录/文件权限默认 0700/0600。零字节文件可上传，已有同内容同名对象校验后复用，不覆盖篡改或符号链接对象。

普通文件每个 64 MiB、每条消息最多 20 个/合计 128 MiB，独立于图片限额。原始上传走已认证、同源的 `POST /api/session/uploadFileBinary`，检查声明长度和实际流量，不经过 48 MiB JSON 聚合路径；既有 `fileUploads/upload` base64 回退仍受 JSON RPC 上限。超限、断流或取消不签发回执并清理本次未完成的临时文件。成功上传返回进程内、Session 专属的 opaque receipt；最多保留 1024 份待用回执，1 小时后过期，Web 重启也需要重新选择未发送文件。持久文件本身不随回执过期自动删除。

发送时先核对所有回执、所属 Session、字节完整性及总限额，再保存图片或创建原生 Thread。首次创建只迁移回执的内存归属到确认的 canonical ID，不建立持久 Thread 索引。文件/图片混合输入仍只沿用一份原生路径上下文；Host 只接收文本路径，不接收普通文件字节或 base64。确认接受后退休回执；拒绝保留草稿与回执，结果未知不自动重发或删除文件。历史文件卡片从原生路径恢复，已发送的文件不依赖上传回执跨重启存在。单个文件的内容如何读取、是否需要审批、是否能解释其格式仍由原生 Harness/工具决定。

范围仍限本地 external-owned 普通 Thread；官方 Codex、子代理上传、远程/WSL 路径转换及显式 standalone 附件未接入。普通文件使用卡片，不声称实现了 PDF/Office/ZIP 等通用预览或下载。模拟测试验证路径可读取与字节保留，不等于每个真实 Harness/Model 的文件解释或图片理解能力均已验收。

## 会话侧栏

侧栏以 DSH 的轻量视觉为底：项目与会话使用一致的 14px 字号，项目组之间保持 4px 间距，时间作为次要信息，保留 Harness 身份及柔和的选中/悬停底色。桌面端右侧操作仅在悬停、键盘聚焦或菜单打开时覆盖显示，不再为三个按钮常驻预留标题宽度；覆盖层与当前行同色，带轻量渐隐边缘。标题位置和宽度不因按钮出现而变化，文字保持静止，停留通过已有详情卡片查看完整标题。新会话使用轻量导航行而非突出卡片。

项目分组初始显示 5 个普通会话，平铺初始显示 10 个，每次再显示 10 个；置顶、草稿、运行中、当前会话及搜索定位目标保持可见，不为定位一个旧会话展开全部历史。这是已有目录的前端展示窗口，不是 Host 目录分页；仍使用同一目录、项目归属和原生 Thread ID。箭头键移动焦点，Enter/空格打开，左右键展开/收起项目，Home/End 定位首尾；移动焦点不会预读正文。右键或 Shift+F10 打开现有操作菜单，Escape/外部点击关闭，不因鼠标短暂离开而消失。手机端显示明确的菜单按钮，主要会话行及菜单按钮至少 44px，快捷归档/置顶收进菜单以避免误触。

文件夹、新会话、搜索、置顶、归档、菜单和设置等通用图标统一使用已有 DSH 图标，不混用另一套粗细和轮廓。文件夹保持轻量 16px 图形：展开时使用蓝色打开造型，收起时恢复灰色闭合造型。颜色直接跟随展开状态，不要求先选中该项目内的会话；鼠标悬停、键盘聚焦和打开菜单时仍保留文件夹，不再替换为箭头。展开/收起继续通过整行点击或左右键操作，`aria-expanded` 保持原有语义。Harness 品牌、权限含义及真实状态保持原义，不替换为 Codex 身份，也不根据参考截图伪造远程连接状态。Codingns4DSH 只作为交互参考，不引入其插件代码、DOM/Fiber 注入或额外 Host。

### 置顶与 Desktop 同步

共享来源调用当前 Desktop 原生 `manager.runtime.pinnedThreads()` 服务的 `list/set`，固定 `hostId: local`、`useAppServerPins: true`；只读查询另传 `preservePinSource: true`，不改变 Desktop 的读取模式。原生服务负责分区移动、关联元数据和 GUI 刷新通知，Web 不直接写 GUI 文件/React 状态，不硬编码 Pinned 分区 ID，也不另建分区或 Harness 会话。只投影共享目录中 external-owned Threads，保留 GUI 顺序；官方 Codex 和远程 Threads 的置顶不展示、不覆盖。

分组、树形及平铺模式都将已置顶会话集中到顶部“置顶”分区，项目内不重复显示，不改变项目归属；项目折叠不影响置顶行。取消置顶后恢复普通列表位置；搜索仍只显示一个结果。置顶区为空时隐藏。行继续沿用 Harness 图标、菜单、键盘导航、当前选中态及手机触摸目标。暂不提供置顶区拖动排序，避免把浏览器本地顺序冒充 GUI 顺序。

Web 操作在原生确认并重新读取后才发布完整置顶集合；查询与写入串行，避免旧查询覆盖新结果。GUI 外部变化沿用目录的 10 秒查询同步（不是实时订阅），多浏览器通过现有 `workspace/follow` 接收变更，无变化不重发。共享模式忽略旧 Web-only 置顶，内存投影不写入 `workspaces.json`，切回显式 standalone 仍使用原有本地置顶记录。尚未产生 canonical Thread 的草稿不能置顶，也不会为了置顶创建原生会话。

Desktop 离线时，独立后台可读取保存的置顶 ID，但尚不提供置顶写入或所有版本的实时原生分区快照。原生服务缺失、拒绝或断线时保留最后确认的投影，操作提示具体失败原因，不静默回退到本地置顶、不自动重试写入。确认读取失败时实际写入可能已经发生，应先刷新核实。此路径依赖当前 Desktop 的原生服务形状，不能据此宣称所有版本已兼容；真实环境仅验证只读入口，双向写入与失败恢复由隔离 Host/CDP 和浏览器测试覆盖，不以测试更改用户真实置顶。

状态继续来自已有投影；原生审批按事件通道能力呈现，未接入的原生未读能力不伪造。正文通用运行文案使用“正在处理 / Working”，不暗示某个 Model、推理模式或深度研究能力。

## 对话轮次导航

正文左侧的轮次导航参考已安装 Codex 的 `thread-user-message-navigation-rail` 与 `floating-navigation-rail-layout` 行为实现：距离正文滚动区左边缘 12px、每项间距 10px；根据正文实际左侧留白判断，少于 48px 时隐藏，不挤占窄屏内容。平时为短刻度，当前阅读轮次加深；悬停目标及相邻三项按距离依次加长。预览向右展开，限制一行提问和三行回复，悬停短暂延迟后出现，键盘聚焦立即显示。

点击沿用 Web 的语义锚点跳转；按住拖动可连续定位已加载消息，松开不会跳回起点，也不会为拖动经过的未加载项发起大量历史请求。导航本身可独立滚动并显示边缘淡出，不触发正文自动加载；保留键盘操作和减少动态效果偏好。标签按导航项位置编号，不暴露内存日志的内部坐标。导航仅呈现已有窗口/outline 中已知的项目，不为构建导航全量读取原生历史。未添加 Codex 的书签、音频可视化或其私有状态存储。

## Harness 与 Model 选择

Composer 的模型/推理等级控件旁提供独立的 Harness 图标按钮。菜单沿用 Desktop 的“图标、Harness 名称、当前勾选”方式；图标来自插件资源，不从 Model Provider 名称推测。就绪插件可选，检查失败的条目标记为不可用。

新会话可切换 Harness；选择时采用该 Harness 目录的首个可用 Model 及其默认推理等级，随后可单独选择其他 Model。模型菜单和 `/model` 只列当前 Harness 的模型。两个控件共用原来的目录、`session/selectModel` 和确认后的持久投影，不维护另一份选中状态。

会话有原生历史后固定 Harness；菜单仍展示其他 Harness，但禁用切换并提示新建会话。当前 Harness 内的 Model 选择保持可用。重新连接或刷新按持久投影恢复，不把现有 Native Session 迁到另一个 Harness。

## 原生权限与会话标识

权限菜单及 `/permission` 读取当前会话的 Adapter 权限目录，保留原生模式 ID、标签、描述与危险标记；不再把 `auto` 解释成 DSH 的 Auto review，也不使用进程全局权限目录为不同 Harness 套用相同预设。危险模式有显式确认；无原生可选权限能力的 Harness 隐藏入口。`atCreate` 模式仅在原生会话创建前可选，之后锁定；原生拒绝显示错误，不伪造切换成功。未打开原生会话时保存所选 ID并在 `Adapter.open` 时传入，已有会话通过 `permissionMode.select` 下发。跨 Harness 的草稿切换恢复目标 Harness 原生默认值，不继承同名模式的语义。全局默认权限设置入口不再显示，因为各 Harness 的模式与生效范围并不相同。

左侧会话行读取服务端持久元数据中的绑定 Harness（草稿读取该会话的已选 Harness），显示插件品牌图标，不从当前 Composer 或其他会话的默认选择推测。未打开的历史会话同样显示，刷新可恢复；运行、审批和未读状态叠加在图标旁，归档保留身份。侧栏与 Harness 选择器通过同一展示组件消费 CH 插件的 `iconStyle`：优先绘制经过公共契约校验的矢量路径，`currentColor` 随主题变化；位图保留插件声明的背景、圆角和留白比例。不直接把固定黑色、带原始留白的 SVG 当成矢量展示，也不对 Pi 单独反色。展示元数据按目录共享读取，不逐会话请求。缺少图标资源或元数据读取失败时使用通用图标，不伪造其他品牌。

## 并发运行与预览

`start:web` 固定监听 localhost 并保留访问令牌认证，默认按需启动或连接同一个独立 CH 后台，无须先打开 Desktop。独立模式通过 `--session-source standalone` 显式选择；其预览默认只启用 Claude Code。服务子进程不继承 `CODEXHOST_*`、`NODE_OPTIONS` 或 `NODE_PATH`。预览默认数据目录为 `~/.codexhost-web-preview`，工作区为 `~/codexhost-web-preview-workspace`；支持 `--port`、`--data`、`--workspace`，以及逗号分隔的 `--harness <id,...>`。默认仅 Claude Code；`npm run start:web -- --harness all` 启用本发行包除 Codex、Pi 和用量统计专用插件外的所有会话插件。显式选择 Codex/Pi、缺失插件或用量统计插件会在启动前报错。

启用插件不等于机器已安装、认证对应 CLI，也不等于所有能力已完成 Web 验收。模型菜单只列检查就绪的 Harness；未安装的不会列为可用，检查失败由目录接口报告。Codex、Pi 的独立启动入口仍未验证，隔离预览始终拒绝启用；其他插件所需的可选 Host 上下文以及完整界面能力也需逐项验收。不要从 CH 承载的 Agent 会话直接启动继承原环境的 `server.mjs`，也不要把 Desktop 的环境变量恢复到预览进程。

共享来源由唯一后台恢复/写入 Native Session；两个界面同时打开不是两个执行所有者。显式 standalone 则独立管理会话，不能同时恢复并写入共享后台正在使用的 Native Session；数据目录隔离不等于原生文件、CLI 账号或额度隔离。不同任务也不应同时修改同一工作目录。

## 验证与限制

```sh
npm run typecheck
npm run test:shared-host
npm run test:web
npm run test:web:distribution
npm run test:web:browser
npm run test:sidebar --workspace=@deepseek-ai/dsh-client-ui-workspace
```

服务端和浏览器测试使用假 Harness、模拟 CH Host/CDP 与临时数据，不提交真实模型请求。`test:shared-host` 另使用真实原生 Launcher/Node 进程及模拟 Codex 协议，隔离 HOME/Codex home/data，验证启动顺序、并发唯一所有者、前台退出、原生参数保留、后台崩溃后的子进程清理及不重发；发行检查覆盖认证 Web-only 自动启动与晚到客户端。模拟协议与 macOS 本地执行不等于真实 Codex、所有 Harness 或其他 OS 已验收。共享来源检查覆盖 canonical 身份、已有 GUI 历史、Web 创建、自动目录分组和不新增会话文件；真实环境仅进行目录/元数据和页面只读检查。浏览器检查覆盖手机尺寸的设置、主题持久化、发送、断网重连和历史恢复；发行检查覆盖仓库外运行、插件资源和隔离启动参数。迁入的 Codex Item 映射测试由仓库 Vitest 配置运行。

CH 与 Web 后端纳入现有 TypeScript 检查；迁入前端由 tsdown/Vite 编译并接受浏览器回归，原 DSH 的完整前端类型检查与测试配置尚未迁入。自动化浏览器尺寸测试不替代真机键盘、后台生命周期和 HTTPS Web Push 验收。本地共享模式通过 `attachmentInput`（含普通文件限额）及 `imageLimits` 声明附件路径能力；仅配置图片存储的连接仍可用 `imagesOnly` 限制图片入口，standalone 仍隐藏附件入口并拒绝非文本提交。图片的接收与展示不代表 Harness/Model 的视觉能力；其执行继续沿用原生文件读取路径。加号菜单中的 `/model` 由前端模型选择模块提供，后端不重复声明同名命令；`/permission` 则由后端执行原生权限选择。
