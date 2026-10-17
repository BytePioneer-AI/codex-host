# 独立 Web 应用

Web 与 Codex Desktop 在同一仓库开发，浏览器通过 `packages/web-server` 的独立 Node 服务访问。默认 `codexhost` 会话来源按需启动或连接独立的本地 CH 后台，复用 CH 的 Thread 目录、创建、读取和操作；Web 网关不直接读写 Mapping Store、不为外部 Threads 启动第二份 Adapter，也不登记 Desktop 进程所有权。默认同时启用 Codex，共享后台另装配一个固定配置的隔离 Web Codex 来源，Web 网关仅连接并与 CH 外部会话合并展示。显式 `--session-source standalone` 保留独立 Harness 插件模式。Web/PWA 共用响应式界面；尚无 iOS/Android 原生封装。

## 代码与构建

- `packages/adapters/*`：唯一的 Harness 接入实现。既有插件保持当前 CH 源码；`packages/adapters/codex` 是迁入的独立 Codex app-server Adapter，不改变 Desktop 原生 Codex 路径，也不加入 Desktop 预装清单。
- `packages/web-server`：Web 会话存储、HTTP/WebSocket、交互关联、Harness 事件到 DSH 界面协议的投影、认证与 Web Push。
- `apps/web-ui`：从 DSH 衍生的浏览器界面、Cordis 浏览器运行时与协议源码；仅保留所选界面依赖，来源和许可见其 README。未迁入 DSH CLI、独立 Agent Loop、原仓库 CI 或 Git 历史。

仓库统一使用 npm Workspace 和 `package-lock.json`。Web 消费公共插件上下文与命令类型；现有会话投影仍使用结构化类型子集，并不是新的 Harness 专属实现。旧 DSH 协议字段 `provider` 在本应用中携带 Harness ID，不表示 Model Provider。

```sh
npm ci
npm run build:web
npm start web
# 4400 已有旧 Web 服务时，不重启 Desktop；改用另一端口：
npm start web -- --port 4401
```

Web 默认端口为 **4400**，控制台默认端口为 **4399**；可用 `--port` 显式覆盖 Web 端口。`npm start web` 默认监听所有 IPv4 网卡；手机可使用终端输出的带令牌局域网或 Tailscale 地址。需要相应网络可达且防火墙允许入站，不会自动配置穿透或公网端口转发。不要将明文 HTTP 直接暴露到不可信网络；跨网络优先使用 Tailscale，或配置 HTTPS 反向代理。

`npm start web` 默认先执行 `build:web`，完整构建并打包当前工作树后启动；成功时仅显示构建进度和耗时，不刷依赖构建明细。构建失败则不启动旧产物，显示末尾最多 64,000 字符的诊断；完整输出可通过 `npm run build:web` 查看。`npm start web -- --no-build` 显式复用已有 Web 发行目录。两种方式都不触发 Desktop 清理或重启；不带 `web` 的 `npm start` 仍启动 Desktop。Desktop 启动前只清理旧 Desktop 及已核实的 Controller，不按 `codexhost` 进程名清理运行时；Desktop 原生 Launcher 负责自身进程树退出，并保留已经独立运行的共享 Host。因此先启动 Web 再启动 Desktop 不应停止共享后台或其任务。原 `npm run start:web` 保留兼容。

`build:web` 编译当前工作树的 CH 包并调用已有插件构建器，构建原生 Launcher，随后编译前端和打包。插件输入为 `packages/host-runtime/dist/plugins`，不是已安装的 CH.app 或另一个仓库。用量统计专用插件不作为聊天 Harness；Web 另行打包同仓库的 Codex Adapter。

发行目录为 `packages/web-server/dist/codexhost-web`，包含 Node 网关、Web 界面、同一 Host bundle、当前平台的原生 Launcher 和自包含插件；会话与用量插件在后台显式启用，Codex Adapter 仅由独立 Web 执行作用域加载，不进入共享 Host 的 external 注册表。整体目录可以移动到仓库外运行，无需源码目录或仓库的 node_modules，但原生 Launcher 不能跨 OS/CPU 使用。默认共享模式也不要求 Desktop 运行：Web、Desktop 均可独立使用，同时开启时共享后台，晚开启的一端读取最新事实；关闭任意界面不停止另一端或后台任务。需要本机受支持的 Node，Harness CLI 和其认证仍由用户安装、配置。

## Web 数据目录

Web 网关自有数据默认位于 `~/.codexhost/web/`，源码入口与打包预览使用相同默认值；指定 `--ch-data <root>` 或对应的 `--ch-control-directory <root>/client-hosts` 时，默认跟随为 `<root>/web`。显式 `--data`（直接 server 入口也支持 `CODEXHOST_WEB_DATA`）仍可选择独立目录，不修改 Host 的 Mapping Store 位置。

该目录包含访问令牌、设置、Push 密钥/订阅、上传附件及 standalone 自有记录。默认隔离 Web Codex home 沿用 `<web-data>/codex-home`，即 `~/.codexhost/web/codex-home`；shared Codex 元数据仍在 `~/.codexhost/web-codex`。用户项目代码、GUI 官方 Codex home 与其他 Harness 的原生数据保持原位。

本版本不会自动合并旧 `~/.codexhost-web-preview` 与 `~/.codexhost-web`。默认目标尚不存在且检测到旧目录时，启动明确报错要求离线迁移或显式选择 `--data`，避免静默创建空配置。已存在目标为默认权威；多份旧 profile 必须分开保留，不混合令牌、Push 密钥或历史。迁移需要停掉使用源目录的网关；已有隔离 Codex home/会话还需独立处理 canonical home 及后台所有权，不能仅移动目录。

离线迁移可保留旧根目录到新根目录的兼容链接，以维持原生历史中的附件绝对路径；实际字节仅存于新目录。仅有链接不会放宽图片读取限制：新目录中的 `data-root-migration-v1.json` 必须记录 `version: 1`、绝对 `sourceRoot` 与 canonical `targetRoot`，旧根链接还必须实际指向当前数据目录。只有该 profile 自有、内容寻址的图片可通过旧路径识别并从新目录校验读取；其他符号链接仍拒绝。未发送上传回执本就不跨网关重启恢复。备份该目录含敏感令牌和密钥，应离线停写并安全保存；只备份 codexhost 目录不等于备份全部原生会话或项目。

## GUI / Web 共享偏好

共享模式下，空闲释放策略、模型收藏、新会话默认 Harness / Model / Thinking / Permission Mode 由共享 Host 持久化到 `$CODEXHOST_DATA_DIR/harness-preferences-v1.json`（默认 `~/.codexhost/harness-preferences-v1.json`）。Host 是唯一写入者；Renderer 与 Web 通过 `codexhost/harness/preferences/get|patch` 读取快照或提交修改，不直接写文件。写入串行合并、原子替换，只有成功保存后的值才作为确认状态；写入失败保留上次有效值。新会话默认配置仅用于之后创建的草稿，按实时 Harness 目录校验，不改动已存在会话。草稿创建或主动切换 Harness 时固定有效权限（包括原生默认权限）；提交和上传时将这份配置直接传给目标来源，不重新读取或保存全局默认值。并发上传的来源准备按草稿串行执行。

变更通过 Desktop 通知和带 cursor 的 Host client channel 广播，Web 转成浏览器事件。重连读取最新快照，不用旧浏览器缓存覆盖文件。正常 GUI/Web 连接不持续轮询偏好：Host 保留文件变更监听，GUI 在恢复焦点或切回可见时读取一次快照；仅没有事件通道的旧 CDP 连接保留 3 秒读取兜底。旧 localStorage 仅作为初始化来源，已存在的文件字段优先，初始化后不再向这些 key 写入。GUI 首次偏好快照晚于 Composer 挂载时，只补初始化未编辑、未提交且未主动配置的草稿；用户已有操作不会被迟到快照覆盖；初始化资格绑定逻辑草稿身份，保留原 DOM 或跨容器重挂载不会重置它。GUI 收藏保存期间暂时禁用对应 Harness 的收藏按钮，保存确认或失败后恢复，并以确认快照回显。收藏锁按连接代次隔离；重连核对最新快照后可继续操作，旧请求结束不会解锁新连接的请求。Web 旧 `preferences.json` 的默认选择同样仅初始化缺失值。草稿文本与队列保持各自原有行为，本次不持久化队列。

`external` 作用域供两端外部 Harness 共享；允许保存“默认选择 Codex”的导航偏好，但拒绝在此保存 Codex 模型、权限或收藏。Web Codex 的配置与收藏使用规范化独立 home 的散列作用域；不同 home 互不影响。GUI 原生 Codex 模型、权限、会话执行继续由官方路径管理，共享偏好不加载或调用 Codex 执行插件。

显式 `--session-source standalone` 的收藏和新会话配置保存在 Web 自身数据目录，不与共享 Host 合并；共享空闲释放设置仅在连接 CH 时提供，适用于 CH 管理的外部会话。Web Codex 的既有资源回收策略不受该设置控制。旧 Host 不支持新接口时，普通会话仍可使用，收藏保存和共享设置不可用。

## Web Codex 加载隔离与路由

`npm start web` 默认启用所有打包的会话 Harness，包括 Codex 与 Pi，无需指定 `--harness` 或 `--codex-command`。需要更换端口时只传 `--port`。启动入口通过原生 Launcher 的安装检查或 PATH 为现有 Codex 连接补齐 CLI 路径。Codex 连接失败时记录日志并继续启动 Web；显式迁移失败仍报错。Adapter、模型目录、会话及登录行为保持不变。

高级诊断仍可指定 `--harness <id,...>`、`--codex-command /absolute/path/to/codex` 等覆盖项，但它们不再是常规启动的前提。

共享模式中 CH 外部会话目录继续由后台提供，Host 额外拥有隔离 Codex，不把该插件加入 Desktop 预装清单或共享 `enabled.json`。插件 Manifest 的安装身份允许 `codex`，但 GUI/CH 的 external 路由、目录和会话导入契约继续拒绝这个身份。Loader/Registry 默认 `external`，在 import、工厂和 warmup 前过滤 Codex；只有显式配置的 `web-codex` scope 可以加载它：shared 由 Host 装配，standalone 由独立 composition 装配。`codex-usage` 仍是独立用量插件。

Web Codex 的原生 home 默认是 `<web-data>/codex-home`，可用 `--codex-home` 指定独立目录；CLI 默认自动发现，显式覆盖路径必须是绝对原生入口。插件拒绝已知代理/shim 和与 GUI home 重叠的路径，子进程清理 Desktop 路由及 Node 注入环境。需要自行在该明确的 `CODEX_HOME` 下配置原生 CLI/登录；不复制 GUI 的凭据、配置或历史。原生引用绑定 canonical home，换 home 后不能继续使用旧引用。后台只接受一个显式 Web Codex 配置；晚到客户端不能替换 home、CLI 或插件路径。profile root 与 home 受排他锁保护，shared 与 standalone 不能并发复用；锁不控制用户手动 CLI，仍不得用另一个 CLI 并发恢复该 home。关闭 Web server 仅断开 shared 来源，后台任务继续；显式 standalone 关闭仍会关闭它拥有的会话。原生关闭失败不释放准入锁。shared 崩溃恢复由 Rust 在旧受监管进程树清理结束后写入私有退出证明，Node 校验旧 PID、supervisor generation 与 canonical Host root匹配后才接管旧 home 锁；证明不匹配或 standalone 缺乏该受监管证明时明确拒绝。不能仅凭 PID 消失或浏览器断线继续执行。

列表、模型目录、搜索与 control baseline 合并两来源；所有会话操作按已绑定的来源分发，不按当前模型选择猜测。草稿只保存在内存，切换 Harness 保留浏览器输入；首次提交才建立所选来源，之后禁止跨来源切换。来源创建/提交在途或结果未知时不重试、不回落另一个来源。混合入口与隔离 Host owner 分别保留有界进程内提交回执；Host 按 Session/requestId 最多保留 256 个，相同输入跨 gateway 复用结果，不同输入拒绝。不承诺跨重启或回执淘汰后的 exactly-once。CH 上传占位草稿切到 Codex 时只清理未提交占位，不修改原生 Thread。shared Codex 的元数据与展示日志位于 `<ch-data>/web-codex`，保留现有 index/events/projections 和原生 checkpoint/backfill/children 格式，不写 CH Mapping Store；standalone 继续使用 `<web-data>/codex-sessions`，两者复用 `session-runtime` 实现。外部 Thread 的身份、历史和操作继续归 CH。

当前 Codex 来源要求发送前选择工作区，仅支持文本输入，附件入口关闭并在服务端拒绝；fork/回退仍按未支持能力处理。独立会话的显式停止先清除本地待发送队列，再取消活动轮，避免取消完成时自动启动下一条；CH 队列继续遵循后台自己的暂停规则。shared Codex 的 Web 自建 workspace、local 置顶/归档由 Host 持久化并按来源投影，不写 GUI 原生分区；CH 原生置顶与已绑定 Codex 的 local 置顶合并展示。官方 pin 离线不可写不阻止会话执行，local pin 不代表官方 GUI 分区已更新。此接入不共享或接管 GUI 原生 Codex Threads，也不声明所有原生工具、平台和高级能力已经完成验收。

显式 `--session-source standalone --harness codex` 可单独使用隔离 Codex；standalone 中不能同时选择 Codex 与其他 Harness，需使用默认共享模式合并来源。

### 显式迁移一个旧 Web Codex 来源

升级不会自动扫描或合并旧 profiles。先在旧 Web 仍运行时确认所有 Turn、队列、审批/问题、提交与上传均已处理，再正常退出并确认旧 writer/native 进程已停止；不能用重启来清空队列。连接新版 shared Host 时指定旧 Web data root、**原来的** canonical Codex home 与 CLI：

```sh
npm start web -- --harness codex --codex-command /absolute/path/to/codex \
  --codex-home /absolute/original/web-data/codex-home \
  --web-codex-migrate-source /absolute/original/web-data --web-codex-legacy-stopped
```

`--web-codex-legacy-stopped` 是用户对已完成静默/退出的明确确认，不是程序通过 mtime/PID 扫描证明的状态。迁移在唯一目标 owner 锁下严格验证并 staging 复制完整会话集合及明确 Web 自建 workspace/隔离 local 组织记录，原子 commit 后切换权威。mixed 文件中的 external 引用和自动项目行不作隔离归属权威迁入；排除项记录在 commit 报告。未知 schema、损坏日志、身份或目标冲突明确失败并保留源，不静默跳过或自动改 ID。

原生 home、历史附件原路径及源备份原位保留，不迁凭据或附件字节。commit 前源、commit 后目标分别是唯一权威；目标已有新业务写入后不得自动恢复旧副本继续执行。源被 `source-migrated-v1.json` 封存，新版 standalone 准入会拒绝再次打开；未认识此标记的旧二进制仍需保持停用，标记不是对旧无锁 writer 的控制。回滚是离线维护操作，先关闭会自动重连的界面；源码构建后可执行：

```sh
node packages/host-runtime/dist/main.js --codexhost-web-codex-rollback \
  --data /absolute/host-data --home /absolute/original/web-data/codex-home \
  --launcher /absolute/path/to/codexhost
```

维护入口调用原生 Launcher 的 `host stop` 等待受监管 owner/进程树退出，再取 profile/home 锁；没有确认退出或目标已有业务 mutation 时拒绝回滚。成功回滚解封原源并封存目标配置；不会暗中把 shared 客户端改为 standalone。shared Host 不支持该能力时明确失败，不 fallback 到本地 Codex。草稿不共享、不恢复内存队列，也不保证跨重启 exactly-once；未知 prompt 结果不自动重发。


## 共享 CH 会话来源

默认发现本地 CH 的认证客户端通道 v1；没有健康服务时，调用同仓库/发行包原生 Launcher 按需启动后台，不启动/重启 Desktop、不重新注入 Renderer。通道描述文件默认位于 `~/.codexhost/client-hosts`。`--ch-data <dir>` 指定后台数据目录，和 Web 的认证/设置 `--data` 分开；还可显式指定 `--ch-launcher`、`--ch-host-runtime`、`--ch-plugins`、`--ch-codex-home`。自定义发现路径为 `--ch-control-directory <ch-data>/client-hosts`，不能用另一个目录暗中创建不同所有者。Desktop 必须使用同一 Host 数据目录和 Codex home，才能共享原会话。

后台持有唯一存储和原生执行所有权；两端并发启动受原生锁保护，关闭前台不释放执行所有权。后台换代仅恢复原生历史与当前可读取事实，不重发写入，不保证崩溃时进行中的任务继续执行。显式维护可运行 `codexhost host stop`，该操作会停止任务；应先关闭会自动重连的界面。生命周期及退出证明见[客户端通道](../architecture/host-client-channel.md)。

已运行的旧 Desktop-owned 通道仍可连接，但不会被接管或停止；迁移须用户另行更新并重启 Desktop。单独指定 `--ch-cdp http://127.0.0.1:<port>` 明确选择旧 CDP 入口；与 control directory 同用时，Thread 请求使用事件通道，CDP 仅为依赖 GUI 的原生置顶服务及旧 Host 项目读取提供入口。独立后台从原生保存文件只读读取项目，Windows 的共享聊天/项目读取不再要求 CDP。已选中的服务通道只重连或启动同一后台，不暗中换成 standalone。仅重建 Web 不会升级正在运行的后台或 Desktop。

只展示 `modelProvider: codexhost` 且 Host 确认属于 external 的 Threads，包括已归档记录；不接入官方 Codex Threads或远程 Hosts。会话身份保持 CH Thread ID；列表、完整历史、模型和权限均从同一个 Host 查询。Web 不新增会话索引、原生引用映射或历史文件，DSH 格式只作可丢弃的内存展示缓冲。事件模式按 Host 通知刷新正在订阅的历史，100ms 合并同一 Thread 的连续变化；普通历史 1.5 秒轮询不再运行。通知只表示状态失效，客户端读取最近 5 轮的权威完整状态，不直接拼接重放的 token。读取期间的新事件会安排下一次校验，不会被正在进行的读取吞掉。目录变化也合并处理；保留每 10 秒的目录/原生项目元数据查询，因为项目归属不属于聊天事件。首次目录通过 `session/list` 一次性返回；后续查询只广播实际新增、修改、移除的条目，不将未变化的全部 Threads 重发为 `api-session/added`。比较覆盖标题、执行目录、更新时间、运行状态、父 Thread 和 Harness 归属；历史/模型/权限投影仍走独立控制流。快照查询失败不推进已发布目录基线，普通列表请求与定时刷新共用同一差量发布路径，避免会话数量较多时事件洪泛阻塞切换与历史帧处理。

### 会话标题与首条消息摘要

Web 展示和搜索共用 `Host name → 首条用户消息 preview → 执行目录 basename → Thread ID`。正式标题仅 trim，不截断；提示词摘要合并空白，显示前 80 个 Unicode 字符，超出加省略号。目录刷新还通过已有控制流更新曾打开过的 Thread 标题投影，即使当前已取消历史订阅，也不会被浏览器旧的 sequenced 投影挡住；标题更新不额外读取历史。

Host 在原生确认首轮开始后，将首条用户消息的文本规范化并限定为 1024 个 Unicode 字符，保存为 Mapping Store 的 `thread-metadata/<id>.json` 中的 `preview`。它独立于正式 `title`，不会阻止 Codex 后续生成标题，也不覆盖用户改名。列表直接读取摘要，不为列表逐个恢复 Native Session；重启后仍可显示。旧记录在已有历史读取/恢复时按需补齐，补摘要本身不改变会话活跃时间。首条消息没有文本时保存空摘要，不借用后续消息；回滚移除唯一一轮时清除摘要。Web 不新增独立标题模型服务，也不持续同步 Harness 原生改名。

### 历史首屏与按需分页

首屏遵循已核实的 Codex 本地最近 **5 轮 full/desc** 路径，按时间顺序显示。事件模式由 Host 快照一次提供元数据、最近页、生效配置和待处理交互；冷历史沿用 Host 的 `thread/turns/list`，热会话从同一投影器取得包含用户输入、Reasoning、工具进展的完整状态，而不是 Desktop 专用的精简 `pendingTurn`。旧入口先读 `thread/read(includeTurns: false)` 再读最近页。两种模式均不等待全部历史、不调用 `thread/resume`，也不把工具/推理裁成摘要。Harness 能力目录异步补入，不阻塞正文。

首屏 snapshot 发出后，仅后台预取 **1 页**较早历史，不自动全量遍历。用户向历史顶部滚动、接近顶部 240px 时自动通过 CH 原生 cursor 补一页，无须点击“加载更早”；滚轮、触摸上翻以及真实向顶部的滚动共享同一分页入口。短页即使尚不足一屏，也能由向更早方向的触摸/滚轮意图触发。初次打开、布局变化或程序恢复滚动位置不会自动遍历旧历史；嵌套工具滚动区和输入框不抢占外层分页。加载中显示轻量状态，复用原有阅读锚点；同一边界不重复请求。失败保留已显示内容并提供“重试加载”，继续滚动不会形成自动重试循环。前台与预取共用在途请求，失败不推进 cursor。头部刷新与旧页请求独立执行，慢旧页不阻塞新消息。重新打开复用已加载窗口，不因多客户端打开而继续后台遍历。

为兼容现有 Web 事件协议，内存展示日志使用从 `2 ** 40` 起始的非负局部序号/Turn 坐标，向前插入时向小序号扩展、向后追加时递增；它们不是原生 Turn 编号，不持久化、不传给 CH、不代表未加载的消息数。旧页插入不重编号现有消息、工具引用或滚动锚点；范围耗尽明确报错。独立模式持久日志仍从零开始。界面复用原有消息组件、折叠工具详情和分页滚动锚点，不复制 Codex 私有渲染器或状态存储。

旧 CDP 入口保留 30 秒空闲复用、60 秒最近页校验及 1.5 秒运行历史查询。事件模式每次打开和重连均读取权威快照，不依赖秒级 `updatedAt` 变化；Host/网关使用有界内存事件窗口、epoch 和递增序号恢复通知。窗口不足或 Host 换代时重新读取，已显示正文保留，连接状态显示“正在重连”。新增轮数超过 5 时继续读到已知尾部，避免漏轮。重复 cursor、跨页重复 Turn、原尾部消失或已显示流式正文被改写仍明确报错，要求重新打开历史，不伪造连续性。所有历史缓冲均仅在内存中；v1 是事件驱动的绝对状态收敛，不是逐 token 差量协议，长工具输出的快照传输仍有优化空间。

### 新会话与无工作区目录

共享模式的通用新会话和“最近”入口默认明确不选择工作区，不继承当前或最近使用的项目；项目行的新会话仍选择该项目目录。草稿可保持不选、选择已有工作区，或通过现有 Host 目录浏览器创建文件夹后选为工作区；切换选择保留输入正文与待发送附件。显式 standalone 仍沿用其要求工作区的创建流程。

发送前只是内存草稿，未选择工作区时不带 `cwd`、不创建目录或 Native Session。Harness/模型/权限可选择；首次发送通过 CH `thread/start` 创建并绑定 canonical Thread ID，再通过 `turn/start` 提交。显式 CDP 入口同样保留 Web 请求中完整的 Harness 路由，不受 Desktop 当前草稿的 Harness/模型/权限选择覆盖。创建后先核对 Host 确认的 Harness 与草稿选择一致，再绑定身份和发送消息；若旧 Desktop 桥改写了路由或归属无法确认，则保留草稿、拒绝发送且不重试创建，不删除可能已分配的 Native Session。仅更新 Web 不会替换运行中的旧 Desktop 桥，需另行更新 Desktop，或使用默认 Host 客户端通道后新建会话。无工作区的创建请求携带明确的 `projectlessWorkspace` 命名提示，由唯一 Host 分配新的执行目录，不随机选择已有工作区、不改变其他 Thread 的 cwd。

默认目录布局对齐本机 Codex 26.1007.21159 的策略：Host 用户的 `~/Documents/Codex/<本地日期>/<提示词命名>/`，取前六个 ASCII 字母/数字词、最多 80 字符，不能生成名称时用 `new-chat`；冲突先用 `-2` 至 `-100`，再尝试随机后缀，独占创建而非复用/覆盖目录。会话目录内创建 `outputs/` 与 `work/`，**实际 cwd 是会话目录本身，不是 `work/`**；子目录创建失败时沿用会话目录作为输出位置。当前使用该默认根目录，不读取或修改 Electron 私有的 `projectlessWorkspaceRoot` 设置。

生成的路径与无项目事实由 Host 原有 Mapping Store metadata sidecar 保存，核心记录仍兼容旧 schema；新 Thread 在 metadata 与核心记录都写入后才发布。`codexhost/workspace/read` 合并只读 GUI 项目事实与 canonical 无项目记录，Web 不新增索引、不写 `.codex-global-state.json`，也不把生成目录注册为侧栏项目。选择真实工作区仍使用其原路径，不创建 Codex GUI 项目或强设 `projectId`。草稿绑定仅导航仍查看它的浏览器，不跳转其他客户端。创建或发送结果未知时不自动重试，草稿在途创建也不允许换身份重发；不自动删除已分配且可能被 Native Session 引用的目录。原生 Fork 的目录语义不在普通新会话目录分配中改写。

执行 `cwd` 不等于用户选择了项目。Web 通过后台只读 GUI 保存在 `CODEX_HOME/.codex-global-state.json` 的本地项目目录、Thread 项目归属与未选项目标记（旧 Host 沿用 CDP），按实际项目根目录补齐导航条目和项目名称；已关联项目的 worktree 归到所属项目，实际执行 `cwd` 保持不变。未选项目的会话保留，但其自动生成的目录不单独列为项目；历史临时目录也不凭路径名称猜测项目。Web 明确选择并实际提交的工作区仍保留。项目元数据不可读取时报错，不回退到全部 `cwd`；目录查询不创建 GUI 项目、不设置 `projectId`、不执行 `mkdir`。显式新建工作区和首次提交无项目会话的目录分配是上述独立写入流程，不由历史分组查询触发。复用已有 `workspaces.json`，旧版本误生成的导航条目仅在共享视图隐藏，不删除记录、会话或物理目录。已经失效的真实项目目录仍能显示历史入口。现有独立模式的历史文件保持原样，不自动迁入共享来源。

共享入口保留文本及图片路径附件发送、停止、原生模型/权限选择及改名。事件模式下，同一 Thread 的 GUI/Web 消息、普通工具进展、生效配置、审批和提问共用 Host 状态。Web 使用原生选项呈现交互，Host 校验并接受第一份有效响应，再通知其余端关闭；断线时撤下交互，重连只恢复仍待处理的请求，不因取消本地卡片而自动回答 Harness。Web/App 发出的用户输入也通过既有 Host 投影广播给 GUI，原生 `clientId` 用于撤下 Web 的乐观回显。已确认发送不会因随后读取失败变成“发送被拒绝”；连接中断导致结果未知时不自动重发。`turn/start` 的请求 ID 去重仅覆盖当前 Host 进程最近 256 条回执，不承诺跨重启或超窗口 exactly-once。同时发送不会另开会话并行执行：Shared Host 持有 Desktop/Web 共用的跟进队列；成功终态自动推进，停止、失败和 unknown outcome 暂停，用户可编辑、删除或显式继续单条消息。活跃窗口内的 Steer 仍使用 Host 的 cancel → terminal → replacement 契约；Web 的 Steer 到达时窗口已关闭或已有 Steer 在途，则保留输入到同一 canonical 跟进队列，不丢弃消息。Desktop 原有的 Steer 校验保持不变。

Web 编辑排队文本消息时，先请求 Shared Host 删除原条目，确认删除成功后回填当前浏览器中该会话的输入框；已有草稿、引用和附件保留，删除期间新增的输入也不覆盖。编辑期间消息不在共享队列中，GUI 和其他 Web 客户端同步撤下旧条目，草稿不跨端同步；用户重新发送后才生成新的排队条目。条目已被取走或删除结果未知时不回填、不自动重试；删除已确认后，投影刷新失败不改变删除结果。含非文本内容的排队消息仍不开放编辑。发往 Host 的 Web 文本输入，以及 Host 返回给 Desktop 的队列文本条目，均补齐原生 `text_elements` 数组；已有原生文本标注保持不变，避免 GUI 解析队列时失败。Web 连接建立新代次时重新创建队列控制流并读取初始状态，避免服务重启期间已经终止的旧流无法恢复、只能刷新页面才能看到后续队列变化。

通用 App 可通过 Web 原有认证访问 `/api/ch/v1/{events,rpc,snapshot,respond}`，不需要理解 DSH 渲染日志，也拿不到 Host 私有 token。协议、恢复顺序和部署边界见[客户端通道](../architecture/host-client-channel.md)。本地草稿、滚动位置和当前选中会话不共享。旧 CDP 模式的审批仍在 GUI 处理；共享 Web 的通用文件预览/下载、完整子会话/后台任务投影仍有边界。公开远程 Host 通道、原生 App、真机后台与推送生命周期不在本次接入内。

### 普通会话 Fork

共享模式的侧栏“分叉会话”和消息尾部“在新对话中分支”通过 `session/fork` 转发至 CH 的 `codexhost/thread/fork`。侧栏选择最近已结束的轮次；消息入口必须对应当前内存历史窗口中的精确 `turn/end`，Web 将展示坐标映射成 canonical `lastTurnId`，包括已向前分页的历史，不把局部序号当成原生 ID，也不自动改到相邻轮次。过期窗口、空历史、草稿和不支持 Fork 的 Thread 明确拒绝；具体 checkpoint 是否可用及运行期间是否允许派生仍由 CH/Adapter 判断。

只实现原执行目录中的普通 Fork，不创建 worktree、不传 cwd 覆盖、不新建 Web 历史副本。CH 负责原生派生、身份及持久化，确认后 Web 刷新目录并使用返回的 Thread ID 打开新会话。两个点击入口均显示失败原因；请求结果未知时不自动重试。Fork 已确认后目录刷新失败不改报创建失败，后续目录同步恢复可见性。客户端仍沿用既有的派生标题更新；标题更新失败不回滚已创建的 Thread。

### 附件：落盘后沿用原生路径上下文

本地共享模式支持 PNG/JPEG/WebP/GIF 的粘贴、文件选择及拖放；图片先在浏览器草稿中预览，只有点击发送才上传。服务端验证整批图片后，将收到的原始字节保存到 `<--data>/attachments/images/<sha256>.<ext>`，目录/文件默认权限为 0700/0600，不使用用户文件名或路径作为落盘位置。内容寻址用于去重与完整性校验，不建立新的 Thread 索引。

转交 Host 的仍是文本输入，沿用 Desktop/CH 的 `# Files mentioned by the user:`、绝对文件路径、`Image attachment: true`、附件指令隔离提示和 `## My request:` 上下文；不是把 base64 发给 Harness，也不是扩展 Harness 的图片协议或声称所有 Model 支持视觉。Harness 是否能读取该路径、是否需要审批以及如何理解图片，仍由其原生工具、权限和 Model 能力决定。适用范围是 Web 与本地 Host 共用文件系统；不将本机路径冒充 SSH/远程/WSL 执行环境中的路径，也不修改 Codex 配置文件。

限制为每张 20 MiB、每条消息 20 张/合计 32 MiB、单边 8192 像素、总像素 6400 万；只检查受支持栅格格式的签名和头部尺寸，不转码或压缩。RPC 请求在解析前限制为 48 MiB（包括 base64/JSON 开销），保留原有认证及同源校验。非法上传在分配原生 Thread 前拒绝。`image-size` 仅用于头部尺寸检查，其 MIT 许可随发行包保留。

共享消息的执行输入与展示分开：`ChAttachments` 从完整的原生文件上下文及 `## My request:`（兼容 `for Codex`）拆出用户正文、标记为图片的引用和普通文件卡片；支持任意原生文件标签、行号及 quoted pasted-file 标签，不要求 Web 的 `image-N` 或 SHA256 命名。普通路径提及、代码示例及不完整/未知上下文仍保持原文，不误删用户 Markdown。结构化 `localImage`、`image` 的 data/file URL 使用同一图片展示入口，优先于冗余的序列化附件信息，不重复显示图片。原生普通文件卡片呈现名字/路径，不读取其内容或假造大小；本 Web 上传的文件卡片显示其实际名字和字节数。历史展示不开放任意文件下载或自动解析文件预览。执行文本及 CH 的原生历史不被改写，界面仍使用 DSH 的既有组件。

`session/attachment` 同时核对当前 external Thread 已加载原生用户消息中的图片来源和其内存展示引用；native `ch-image` ID 不携带可由客户端解码的路径，并按 Thread 隔离。读取接口不接受浏览器传入的路径、标签或元数据作为授权；猜测 ID、其他 Thread 的引用、工具输出和正文中的普通路径不能取得文件。原生本地图片（包括 `codex-clipboard-<UUID>` 临时文件和原始文件路径）在其原位置只读访问，不复制到 Web 数据目录，也不新增持久图片映射。Web 自有文件仍按 SHA256 校验；原生文件在当前展示窗口中捕获内容指纹，读取时变化则拒绝。刷新、Web 重启及较早分页均从 CH 历史重建引用；尚未加载的旧页不会授予读取权限。

本地文件读取拒绝路径遍历、符号链接（包括附件路径内的目录链接）、非普通文件和超限图片；仅容许系统 temp/home 根目录的已知真实路径别名。读取有字节上限并检查过程中大小/修改时间的变化。服务端不抓取 HTTP/HTTPS、app/blob 或远程 file URL，避免图片预览变成任意下载/SSRF 接口。文件缺失、无法读取、不支持、超限或浏览器解码失败时保留用户正文并显示“图片不可用，点击重试”，不回退展开整段执行上下文，也不使整个历史失败；明确重试可恢复后来重新可读的图片。不转换 SSH/WSL/远程路径，不修改 Codex 配置或附件文件。

已建立会话的发送被拒绝时保留图片草稿；提交结果未知时不自动重发，也不删除可能已被 Native Session 引用的图片。Web 上传的文件保留在数据目录，不自动随会话删除；手动清理会使历史预览失效。原生临时文件仍遵循原生生命周期，Web 不保证其长期保留。

本地共享入口也支持任意类型的普通文件（TXT/PDF/Office/ZIP/未知扩展名等），不做 MIME 或扩展名白名单，不解压、转码或执行文件。选择或拖入后沿用 DSH 后台上传及进度/重试/移除组件；上传完成前不能发送。原始字节以流式方式写入 `<--data>/attachments/files/<sha256>/<安全文件名>`，保留常规扩展名及 Unicode 名字，清理路径分隔符、控制字符与平台保留名；目录/文件权限默认 0700/0600。零字节文件可上传，已有同内容同名对象校验后复用，不覆盖篡改或符号链接对象。

本地普通文件不设应用层的单文件大小、文件数量、消息总大小或待用回执数量上限。浏览器 Blob、Uint8Array 和流都走已认证、同源的 `POST /api/session/uploadFileBinary` 原始字节路径，不因文件大小转入 48 MiB JSON 聚合路径，也不整文件聚合到服务端内存。旧 `fileUploads/upload` base64 RPC 仅保留兼容，仍受通用 JSON RPC 传输上限，不是浏览器上传入口。磁盘空间、文件系统、浏览器/Node、代理和网络的实际约束仍然存在；图片限额独立保留，不将普通文件策略扩大为所有 Model/Harness 无限制。

断流、取消或存储失败不签发回执并清理本次未完成的临时文件。成功上传返回进程内、Session 专属的 opaque receipt，1 小时后过期，Web 重启也需要重新选择未发送文件。回执过期只回收内存授权，持久文件本身不自动删除；拒绝其他 Session 的回执、符号链接、字节篡改和原生执行权限边界均保持。

发送时先核对所有回执、所属 Session 及字节完整性，再保存图片或创建原生 Thread。首次创建只迁移回执的内存归属到确认的 canonical ID，不建立持久 Thread 索引。文件/图片混合输入仍只沿用一份原生路径上下文；Host 只接收文本路径，不接收普通文件字节或 base64。确认接受后退休回执；拒绝保留草稿与回执，结果未知不自动重发或删除文件。历史文件卡片从原生路径恢复，已发送的文件不依赖上传回执跨重启存在。单个文件的内容如何读取、是否需要审批、是否能解释其格式仍由原生 Harness/工具决定。

范围仍限本地 external-owned 普通 Thread；官方 Codex、子代理上传、远程/WSL 路径转换及显式 standalone 附件未接入。普通文件使用卡片，不声称实现了 PDF/Office/ZIP 等通用预览或下载。模拟测试验证路径可读取与字节保留，不等于每个真实 Harness/Model 的文件解释或图片理解能力均已验收。

## 会话侧栏

Web 侧栏与空会话主视觉共用 `ui-brand-official` 提供的原版“抱块水獭”标记：倾斜模块、双道胡须、原始脸部与尾巴比例保留，使用 SVG 曲线路径，不嵌入截图或 PNG 遮罩。主体固定深蓝 `#082e59`，模块默认绿色 `#19a785`，不随文字颜色变黑或反色；暗色主题仅增加浅灰圆底并将主体缩小 10% 提供留白。该标记只代表 CodexHost，不替换会话的 Harness 身份图标，也不改变 Desktop 侧栏或应用图标。

侧栏以 DSH 的轻量视觉为底：项目与会话使用一致的 14px 字号，项目组之间保持 4px 间距，时间作为次要信息，保留 Harness 身份及柔和的选中/悬停底色。桌面端右侧操作仅在悬停、键盘聚焦或菜单打开时覆盖显示，不再为三个按钮常驻预留标题宽度；覆盖层与当前行同色，带轻量渐隐边缘。标题位置和宽度不因按钮出现而变化，文字保持静止，停留通过已有详情卡片查看完整标题。新会话入口使用轻量导航行而非突出卡片；未发送的草稿只留在 Composer，不作为“新会话”条目进入侧栏，首次提交并绑定真实 Thread 后才显示会话行。会话标题与 Harness 身份按当前 Codex GUI 的外观对齐：系统字体、14px/20px、字重 430，标题和 `currentColor` 图标共用 `text-primary/85`（浅色 `#1a1c1f`、显式深色 `#ffffff`）；侧栏 Harness 图形为 14px，与标题相隔 8px，不再继承 DSH 状态槽的浅灰色。插件显式品牌色（如 Claude）继续由原生 `iconStyle` 决定，项目文件夹/状态徽标仍保持各自语义，不创建 Web 专用 Pi 图标。整个侧栏（包括项目、导航和时间文字）共用系统字体与原生文字色阶，禁止合成字重；新会话导航为 14px/21px、字重 430，分组标题为 14px/21px、字重 500，弱化文字使用原生约 50% 透明度。外观对照包含实际 CJK/Latin 字体回退与截图，不以 CSS 参数相同推断整个界面像素一致；DSH 布局、浏览器字体栅格化和 Desktop 窗口材质仍可造成视觉差异。

只有原“未分组”区域改名为“最近 / Recents”，其会话不按执行目录再分组，固定按更新时间倒序，即使其他项目选择手动排序也不改变它；不提供会改写该顺序的拖动排序。其他项目分组/树形模式和 22px 子会话缩进保持，最近、置顶及单列表不继承项目缩进。“最近”标题带折叠箭头与同款 compose 新会话入口，不伪装成文件夹。

项目分组初始显示 5 个普通会话，平铺初始显示 10 个，每次再显示 10 个；置顶、运行中、已创建的当前会话及搜索定位目标保持可见，未发送草稿不计入窗口，也不为定位一个旧会话展开全部历史。这是已有目录的前端展示窗口，不是 Host 目录分页；仍使用同一目录、项目归属和原生 Thread ID。箭头键移动焦点，Enter/空格打开，左右键展开/收起项目，Home/End 定位首尾；移动焦点不会预读正文。右键或 Shift+F10 打开现有操作菜单，Escape/外部点击关闭，不因鼠标短暂离开而消失。手机端显示明确的菜单按钮，主要会话行及菜单按钮至少 44px，快捷归档/置顶收进菜单以避免误触。

新会话各入口统一使用原生 filled compose 的同一两条路径，Regular/Medium 不改变其几何，尺寸仍由控件决定；其余文件夹、搜索、置顶、归档、菜单和设置等通用图标沿用已有 DSH 图标，不混用另一套粗细和轮廓。文件夹保持轻量 16px 图形：展开时使用蓝色打开造型，收起时恢复灰色闭合造型。颜色直接跟随展开状态，不要求先选中该项目内的会话；鼠标悬停、键盘聚焦和打开菜单时仍保留文件夹，不再替换为箭头。展开/收起继续通过整行点击或左右键操作，`aria-expanded` 保持原有语义。Harness 品牌、权限含义及真实状态保持原义，不替换为 Codex 身份，也不根据参考截图伪造远程连接状态。Codingns4DSH 只作为交互参考，不引入其插件代码、DOM/Fiber 注入或额外 Host。

### 置顶与 Desktop 同步

共享来源调用当前 Desktop 原生 `manager.runtime.pinnedThreads()` 服务的 `list/set`，固定 `hostId: local`、`useAppServerPins: true`；只读查询另传 `preservePinSource: true`，不改变 Desktop 的读取模式。原生服务负责分区移动、关联元数据和 GUI 刷新通知，Web 不直接写 GUI 文件/React 状态，不硬编码 Pinned 分区 ID，也不另建分区或 Harness 会话。只投影共享目录中 external-owned Threads，保留 GUI 顺序；官方 Codex 和远程 Threads 的置顶不展示、不覆盖。

分组、树形及平铺模式都将已置顶会话集中到顶部“置顶”分区，项目内不重复显示，不改变项目归属；项目折叠不影响置顶行。取消置顶后恢复普通列表位置；搜索仍只显示一个结果。置顶区为空时隐藏。行继续沿用 Harness 图标、菜单、键盘导航、当前选中态及手机触摸目标。暂不提供置顶区拖动排序，避免把浏览器本地顺序冒充 GUI 顺序。

Web 操作在原生确认并重新读取后才发布完整置顶集合；查询与写入串行，避免旧查询覆盖新结果。GUI 外部变化沿用目录的 10 秒查询同步（不是实时订阅），多浏览器通过现有 `workspace/follow` 接收变更，无变化不重发。共享模式忽略旧 Web-only 置顶，内存投影不写入 `workspaces.json`，切回显式 standalone 仍使用原有本地置顶记录。尚未产生 canonical Thread 的草稿不能置顶，也不会为了置顶创建原生会话。

Desktop 离线时，独立后台可读取保存的置顶 ID，但尚不提供置顶写入或所有版本的实时原生分区快照。原生服务缺失、拒绝或断线时保留最后确认的投影，操作提示具体失败原因，不静默回退到本地置顶、不自动重试写入。确认读取失败时实际写入可能已经发生，应先刷新核实。此路径依赖当前 Desktop 的原生服务形状，不能据此宣称所有版本已兼容；真实环境仅验证只读入口，双向写入与失败恢复由隔离 Host/CDP 和浏览器测试覆盖，不以测试更改用户真实置顶。

侧栏会话的 Harness logo 始终独立于运行状态。运行中在右侧原时间位置显示 16px 转圈，浏览器已有的“运行结束但尚未打开”完成提醒在同一位置显示蓝点；空闲/已查看后恢复时间，打开会话仍按原有逻辑清除完成提醒，不另建已读索引。置顶、项目、最近、单列表和搜索状态位置一致；置顶图形仍独立保留，手机状态与 44px 菜单按钮并排而不重叠。审批/提问继续使用原有优先级和紧凑文字，归档与未发送草稿不显示新的活动标记，详情卡片保留状态说明。

状态继续来自已有投影；原生审批按事件通道能力呈现，完成提醒仅是当前浏览器观测到的运行结束状态，不冒充 Codex 的持久未读状态或跨端已读同步。正文通用运行文案使用“正在处理 / Working”，不暗示某个 Model、推理模式或深度研究能力。

## 对话轮次导航

正文左侧的轮次导航参考已安装 Codex 的 `thread-user-message-navigation-rail` 与 `floating-navigation-rail-layout` 行为实现：距离正文滚动区左边缘 12px、每项间距 10px；根据正文实际左侧留白判断，少于 48px 时隐藏，不挤占窄屏内容。平时为短刻度，当前阅读轮次加深；悬停目标及相邻三项按距离依次加长。预览向右展开，限制一行提问和三行回复，悬停短暂延迟后出现，键盘聚焦立即显示。

点击沿用 Web 的语义锚点跳转；按住拖动可连续定位已加载消息，松开不会跳回起点，也不会为拖动经过的未加载项发起大量历史请求。导航本身可独立滚动并显示边缘淡出，不触发正文自动加载；保留键盘操作和减少动态效果偏好。标签按导航项位置编号，不暴露内存日志的内部坐标。导航仅呈现已有窗口/outline 中已知的项目，不为构建导航全量读取原生历史。未添加 Codex 的书签、音频可视化或其私有状态存储。

## Harness 与 Model 选择

Composer 的模型/推理等级控件旁提供独立的 Harness 图标按钮。菜单沿用 Desktop 的“图标、Harness 名称、当前勾选”方式；图标来自插件资源，不从 Model Provider 名称推测。就绪插件可选，检查失败的条目标记为不可用。

Harness 菜单与 GUI 共用默认顺序，Codex 固定在首位；排序继续由 Host 管理同一 CH 数据目录的 `harness-display-settings-v1.json`，保留已保存的 Main/More 顺序并扁平展示。不可用项同样按该顺序排列，排序不改变可用性、默认模型或路由。Host 保存成功后发送 `codexhost/harness/display-settings/changed`，client channel 对应 `display-settings-changed`；各入口在订阅后读取确认快照，已连接 GUI、Web 与 Console 自动同步，无需刷新。Console 通过自己的 HTTP 事件流转发 Host 通知，不访问浏览器本地文件。Web 目录从 Host 确认快照读取排序，`codexhost/display-settings/get|set|capabilities` 转发对应公共接口，`codexhost/display-settings-changed` 刷新浏览器目录及已打开的菜单；旧 Host 缺少排序读取方法时，保持同一文件的只读兼容入口。Host 监听排序文件的原子替换以覆盖独立 Host 进程之间的写入。

排序事件能力由独立的 `codexhost/harness/display-settings/capabilities` 请求确认，不在旧严格排序响应中增加字段。支持事件时没有 3 秒排序读取；明确缺少事件能力或通知传输的旧入口保留 3 秒兼容读取，不能通过通知超时推断能力。重连、恢复焦点或可见时补读；通知发生在初读或在途读取期间会合并，并在读取完成后再核对。写入失败保留确认排序，退役连接和旧请求的迟到响应不能覆盖当前视图。订阅和恢复监听随入口销毁清理。这条展示设置链路不加载 Codex 执行插件、不修改官方请求或 Session 所有权。

新会话可切换 Harness；选择时采用该 Harness 目录的首个可用 Model 及其默认推理等级，随后可单独选择其他 Model。模型菜单和 `/model` 只列当前 Harness 的模型。两个控件共用原来的目录、`session/selectModel` 和确认后的持久投影，不维护另一份选中状态。

Composer 模型入口采用 Codex-CH 式嵌套选择：主卡直接列出当前 Model 的原生思考强度，并以底部 Model 行打开左侧搜索列表；桌面端两卡并列保留上下文，窄屏切换为单卡并提供返回按钮。选择 Model 或思考强度成功后关闭整个浮窗，并将焦点恢复到入口按钮且不显示焦点环；点击当前 Model 或当前强度也直接关闭，不重复提交或重置强度。选择失败时保留菜单并显示错误提示，可继续重试。若请求等待期间用户已离开或重新打开菜单，迟到的成功响应只更新选择，不抢回焦点或关闭新打开的菜单。需要调整新 Model 的思考强度时重新打开入口，仍只展示该 Model 实际声明的等级。模型收藏由本地 Host 保存并与 Desktop 共享，用于收藏排序，不改变当前会话模型，也不把没有原生 reasoning metadata 的 Model 补成固定等级。

会话有原生历史后固定 Harness；菜单仍展示其他 Harness，但禁用切换并提示新建会话。当前 Harness 内的 Model 选择保持可用。重新连接或刷新按持久投影恢复，不把现有 Native Session 迁到另一个 Harness。

## 原生权限与会话标识

权限菜单及 `/permission` 读取当前会话的 Adapter 权限目录，保留原生模式 ID、标签、描述与危险标记；不再把 `auto` 解释成 DSH 的 Auto review，也不使用进程全局权限目录为不同 Harness 套用相同预设。危险模式有显式确认；无原生可选权限能力的 Harness 隐藏入口。`atCreate` 模式仅在原生会话创建前可选，之后锁定；原生拒绝显示错误，不伪造切换成功。未打开原生会话时保存所选 ID并在 `Adapter.open` 时传入，已有会话通过 `permissionMode.select` 下发。跨 Harness 的草稿切换恢复目标 Harness 原生默认值，不继承同名模式的语义。全局默认权限设置入口不再显示，因为各 Harness 的模式与生效范围并不相同。

左侧会话行读取服务端持久元数据中的绑定 Harness（草稿读取该会话的已选 Harness），显示插件品牌图标，不从当前 Composer 或其他会话的默认选择推测。未打开的历史会话同样显示，刷新可恢复；运行、审批和未读状态叠加在图标旁，归档保留身份。侧栏与 Harness 选择器通过同一展示组件消费 CH 插件的 `iconStyle`：优先绘制经过公共契约校验的矢量路径，`currentColor` 随主题变化；位图保留插件声明的背景、圆角和留白比例。不直接把固定黑色、带原始留白的 SVG 当成矢量展示，也不对 Pi 单独反色。展示元数据按目录共享读取，不逐会话请求。缺少图标资源或元数据读取失败时使用通用图标，不伪造其他品牌。

## 并发运行与预览

`npm start web` 默认监听 `0.0.0.0:4400`，允许局域网及 Tailscale IPv4 地址访问，并保留访问令牌认证与同源校验；可通过 `npm start web -- --host 127.0.0.1` 限制为仅本机访问，默认按需启动或连接同一个独立 CH 后台，无须先打开 Desktop。独立模式通过 `--session-source standalone` 显式选择；其预览仍默认只启用 Claude Code。服务子进程不继承 `CODEXHOST_*`、`NODE_OPTIONS` 或 `NODE_PATH`。预览默认数据目录为 `~/.codexhost/web/`，工作区为 `~/codexhost-web-preview-workspace`；支持 `--port`、`--data`、`--workspace`，以及逗号分隔的 `--harness <id,...>`。默认与 `--harness all` 一样选择全部打包的会话插件（包括 Codex、Pi，不包括用量统计专用插件）。显式选择缺失插件或用量统计插件仍会在启动前报错；机器没有安装 CLI 或检查连接失败则是正常的不可用状态，不阻止 Web 启动，也不自动安装、登录或发送模型请求。

启用插件不等于机器已安装、认证对应 CLI，也不等于所有能力已完成 Web 验收。模型菜单只列检查就绪的 Harness；未安装的不会列为可用，检查失败由目录接口报告。Pi 不再被预览入口排除，但其独立启动能力仍需专项验收；Codex 的加载/路由及隔离由假原生协议和浏览器回归覆盖，真实模型与高级能力仍需专项验收；其他插件所需的可选 Host 上下文以及完整界面能力也需逐项验收。不要从 CH 承载的 Agent 会话直接启动继承原环境的 `server.mjs`，也不要把 Desktop 的环境变量恢复到预览进程。

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

CH 与 Web 后端纳入现有 TypeScript 检查；迁入前端由 tsdown/Vite 编译并接受浏览器回归，原 DSH 的完整前端类型检查与测试配置尚未迁入。自动化浏览器尺寸测试不替代真机键盘、后台生命周期和 HTTPS Web Push 验收。本地共享模式通过 `attachmentInput` 及独立的 `imageLimits` 声明附件路径能力；仅配置图片存储的连接仍可用 `imagesOnly` 限制图片入口，standalone 仍隐藏附件入口并拒绝非文本提交。图片的接收与展示不代表 Harness/Model 的视觉能力；其执行继续沿用原生文件读取路径。加号菜单中的 `/model` 由前端模型选择模块提供，后端不重复声明同名命令；`/permission` 则由后端执行原生权限选择。
