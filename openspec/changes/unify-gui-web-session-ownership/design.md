## Context

shared external 已由 `shared-host-service` 创建唯一 `externalOnly` AppServerHost，MappingStore 持生命周期锁，客户端断线只 detach。GUI native Codex 保留 official route。Web `main.ts` 另外构造 `web-codex` HarnessRegistry 与本地 Sessions；MixedSessions 按已绑定来源组合列表/操作。Sessions 的 index 含 nativeRef、backfill、checkpoint、children；events/projections 是现有 owned-session presentation journal，不能只搬列表索引。

本change的specs是执行与验收权威；本设计说明实现取舍。所有内容尚未实施。

## Goals / Non-goals

目标是让默认 shared 模式中的现有隔离 Web Codex 来源由 Host 唯一拥有，Web server退出不再关闭其执行，迁移时不改变原生身份或丢失历史/组织数据。只支持一个显式配置的 Web Codex home和一个迁移源；不自动发现/合并profiles。

不改变external执行、GUI native、已共享偏好；不把所有schema统一，不增加多home注册产品、不构造分布式框架。队列只保留当前内存行为，草稿不共享，Codex用量存储不设计。

## Decisions

### 1. 抽取现有 owner，而非再写一个 Host

新增 `@codexhost/session-runtime` 是边界抽取：Host与standalone是两个真实composition消费者，Host不能导入web-server的应用入口或具体Adapter。包拥有现有隔离Sessions的native session运行、interaction、关闭/恢复、metadata和journal写入；Host注入公共 Harness resolver与固定配置。external runtime和MappingStore不迁入该包。

抽取前逐项分离当前Web imports：RpcRegistry/StreamRegistry、EventHub、HTTP认证、Push、Workspaces的UI/官方投影留在Web或其现有owner。包仅使用现有Harness输入/输出、能力、nativeRef等公共类型。公共exports按现有实际操作提供list/read、prompt/cancel、configuration、interaction response和close等窄方法；具体方法以实际调用追踪为准，不预设generic execute/command bus。能力透传，不因抽取启用或删减native功能。

现有TurnProjector与SessionLog中负责持久结算的部分可作为包内明确命名的兼容模块保留；其DSH形状是历史兼容格式，不是通用native事实。Web持有RPC/stream/UI帧投影及可丢弃缓存；核心执行入口不依赖DSH浏览器类型。GUI官方路径不能用该journal推断native状态。不新增EventStore层。

### 2. 一个配置，一个后台执行 owner

Host composition只接受显式固定的Web Codex CLI/home配置，默认不加载Codex执行插件。复用现有external/web-codex插件scope过滤及Adapter canonical home guard，保持Web home与GUI home及其父子路径不重叠、nativeRef locator匹配。已有后台配置不能被晚到客户端替换；重复相同配置连接同owner，配置冲突明确拒绝。此次不提供运行时新增home或通用registry。

跨进程地址携带服务端返回的来源scope和sessionId；Web Codex scope沿用canonical home hash，external保持现有canonical ID。scope仅用于访问已配置来源，不是让请求选择home、Adapter或nativeRef的执行参数。Host在所有read/write/interaction入口校验地址及能力；未知/跨来源身份不fallback官方或本地。GUI native不是可执行external地址，Web Codex不发布成GUI external row。

Host复用Launcher准入、进程树退出证明与现有存储锁纪律；新隔离存储也须防止第二composition可写。锁只约束codexhost进程，不宣称能控制用户手动CLI，独立home仍不得被CLI并发恢复。配置变更/owner交接先确认无活动或未决操作，再停止旧native实例并交接锁。

### 3. 复用通道，不另建同步系统

扩展现有client channel的受限方法与snapshot来源，复用epoch/sequence、hello reset、失效通知、慢客户端detach和重连读baseline。写命令不自动重试；有界进程内receipts保持现有保证，不承诺跨重启exactly-once。native接受结果未知时先核对owner/native事实；无法证明时显示未知，不把absence当未接受证明。原生关闭未确认阻止第二resume。

纯Web使用无需Desktop/stock GUI Codex。gateway断线或停止不关闭隔离owner，explicit host stop则按已有原生监督流程停止。后台崩溃后先证明旧树退出，恢复metadata/nativeRef/journal并结算上代未闭合Turn；不重发prompt或恢复不存在的内存queue，不保证原任务继续。Web Push仍依赖网关存活，不承诺网关关闭后推送。

### 4. 分区保留格式，组织数据只迁Web自有

external仍使用MappingStore。隔离来源保存完整现有index/events/projections；以一个带版本的来源描述记录canonical home、源root与兼容格式，不混入external records。MappingStore当前native key忽略home，因此不能将Web nativeID直接混入其中。

目标布局拟议为 `<host-data>/web-codex/`（来源描述、sessions index/journal）与同来源的Web自有组织数据文件；准确文件名实现时确定，不为目录统一重写schema。只迁明确Web自建workspace ID/root/name，以及隔离local会话的归属/pin/archive，并按scope投影；只有用户明确保存的值作为业务数据，不迁草稿或临时页面状态。现有workspaces.json是mixed文件，external归属/pin/archive与自动/legacy reference rows不作为此来源权威迁入。自建workspace中的external session引用第一期排除并报告，仍由既有GUI/Host投影提供；这些合法引用不当成隔离来源悬引用而阻止迁移。

官方projects继续只读读取官方保存文件；external既有项目映射补充和Desktop官方pin写入保持。local pin不冒充官方pin，官方pin离线不可写但不阻止会话执行。第一期不承诺Host自建workspace/local pin自动进入官方GUI分区。

### 5. 单源静默迁移，不自动修复身份

先增加可验证的新版源owner锁/实例登记与能力门槛，再提供显式迁移。旧无锁Web在仍运行时核实无turn、queue、interaction、in-flight submission/upload，正常shutdown并确认无writer；不能从shutdown后的文件推断已丢失的内存状态。没有状态接口的legacy版本须用户明确确认任务/队列/交互已处理再退出。PID/mtime扫描或marker不是停写证明。

唯一Host锁内严格读取源，staging复制完整恢复集合与Web自有组织数据，验证引用/identity/摘要，原子发布commit记录后切换gateway。未知schema、坏中段/断seq、源变化、目标非空冲突或重复ID均阻止发布，保留源并报告；第一期不自动改ID、生成alias或native去重。源原始字节备份保留；已知不完整末尾行也先拒绝迁移，不默默跳过损坏。

index中的nativeRef/backfill/checkpoints/children及cwd保持，events的seq保持，projections作为展示确认快照复制，不据此重算nativecheckpoint。`harness.jsonl`仅debug诊断，留源备份不参与目标恢复。保留原canonical home，改变data root不能重算home或偏好scope；不复制凭据。历史附件目录保持原位，不搬迁/GC；新请求不接收任意历史路径，按既有受限文件能力访问。

commit前源唯一权威，commit后目标唯一权威。失败不启第二writer、不发送native请求；根据commit记录恢复。回滚先停止新owner并证明native退出；没有新mutation时可恢复源。有新写入时拒绝自动回退旧副本，避免分叉。已迁源不能用旧版本继续写；协议能力和数据schema门槛明确失败，不local fallback。

### 6. standalone保留部署角色，实现只一份

默认shared持续连接同Host profile。explicit standalone复用session-runtime，仅composition与持久root不同，不成为shared失联兜底。禁止与shared并发使用相同root/home；显式顺序交接须走停写、native退出和锁转移。完成后删除shared模式本地执行分支，不永久维护两套Sessions实现。

## Validation and rollout

先抽取保持既有行为，再加入Host composition/通道与准入，然后迁移单源与组织数据，最后收口shared本地执行并更新当前行为文档。定向测试覆盖两启动顺序/并开/第二writer、GUI native拒绝接管、断线/关闭/idle失败/崩溃恢复、静默迁移与损坏冲突、commit故障与回滚。实现时从package.json选验证命令，运行boundary checker；真实native生命周期实测与自动测试分别记录，不提前宣称已验证。
