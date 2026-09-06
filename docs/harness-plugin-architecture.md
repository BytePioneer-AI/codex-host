# Harness 插件化架构与行为保持迁移方案

> 状态：目标架构提案；七个既有 Harness 已统一动态加载并分离打包，完整迁移尚未完成。本文接口示例不应视为当前仓库 API；已实现范围、使用契约和剩余限制见[插件运行时实现说明](harness-plugin-runtime.md)。
>
> 分析基线：提交 `d2fc9391f5de076394e1b99970bb1bb2f137e5be` 的源码、相关测试断言和修改历史。分析未运行原生 Harness 或回归测试，不构成运行时兼容性证明。实施前须重新核对源码与基线差异。

## 1. 结论与目标

目标是把 codexhost 变成不认识具体外部 Harness 的宿主：公共层从指定位置发现插件，每个插件提供自己的名字、图标、安装信息、能力、原生实现和兼容逻辑。新增 Harness 只交付插件和安装配置，不修改核心或重新构建 Renderer。

这一架构可行。当前已经具备 `HarnessAdapter / HarnessSession`、相对独立的原生 Transport 和通用 Renderer 控件，没有发现必须削减现有 Harness 能力才能插件化的结构性障碍。

但可行不等于迁移必然零回归。方案将“不降低任何现有 Harness 已支持能力、不改变其既有语义”作为发布约束，通过行为基线、分阶段迁移、历史兼容和回归验证保障；不能在实施与验证之前承诺不存在未知问题。

对持续接入和独立更新 Harness 的 codexhost，该架构长期优于静态接线。推荐实现“轻量宿主 + 强类型插件”，而不是万能 RPC、任意插件 UI 或复杂扩展平台。

### 1.1 可检验的目标

1. 公共生产代码不 import 具体外部 Harness 包，不按其 ID 选择执行、恢复或展示策略。
2. 插件携带描述信息、资源、入口、依赖、原生适配和私有兼容逻辑。
3. 核心和 Renderer 不维护外部 Harness 名单。
4. 插件列表按目标 Host 获取，本机与远端可以安装不同插件。
5. 移除所有外部插件后，核心与 Renderer 仍能构建运行，官方 Codex 路径保持可用。
6. 源码中从未出现过的插件 ID，在安装、启用并重启后可以被发现、展示和调用。
7. 原有 Thread、Native Session、配置、交互和受支持操作通过既定兼容验收。

### 1.2 “公共层没有专属代码”的范围

这里的公共层包括外部 Harness 的 Host 编排、协议路由、共享契约、Renderer 和通用加载设施，不包括具体插件实现。

允许具体 Harness 名称出现在所属插件、插件测试、发行版预装清单、兼容夹具和用户文档中。验收关注生产依赖与运行策略，而不是全仓库字符串清零。预装清单属于发行组合，不能重新变成核心运行代码中的静态 Adapter import。

Codex Desktop 协议、官方 app-server、Renderer 兼容绑定仍是 codexhost 的产品集成，不要求在本次迁移中改成另一套通用前端插件。术语遵循[领域术语表](领域术语表.md)，Harness、Model、Provider、Account 不得混用。

### 1.3 非目标

- 不重新实现各 Harness 的 Agent Loop。
- 不强制把原生 SDK、RPC、CLI 或 Host API 统一降为 ACP。
- 不为形式统一而重写现有 Transport、历史与事件投影。
- 不在第一阶段做插件市场、自动下载、自动升级、热替换或运行中卸载。
- 不允许插件任意访问 Desktop 内部 DOM、React 状态、Electron 私有 API 或 RequestManager。
- 不提供无限制的 `invoke(method, any)` 或任意插件 HTML/JavaScript 注入。
- 不将原本不支持的能力或已知缺陷修复夹带进“行为保持”迁移。

## 2. 分析基线与主要差异

本节记录迁移前的分析基线；其中静态 Adapter 组合和 Host Bundle 内嵌 SDK 已在后续实施中移除。当前实现状态以[运行时说明](harness-plugin-runtime.md)为准。

以下是影响架构的行为摘要，不是完整能力矩阵，也不是实机验证结果。能力须按原生版本、协议代际和运行模式进一步固化。

| Harness | 当前实现特点 | 迁移必须保留的差异 |
| --- | --- | --- |
| Pi | 原生 RPC；Model/Thinking、命令、提问、自主 Turn、Fork/跨目录 Fork/Rollback | 不提供会话级 Permission Mode 选择，不可强加其他 Harness 的权限配置 |
| Claude Code | Agent SDK；审批、提问、Subagent、后台延续、Credits；支持 Fork/Rollback，不支持跨目录 Fork | 原生回调和后台生命周期；macOS 受管远程有专属 Broker 承载 |
| OMP | 原生 RPC；权限模式、审批与提问、Subagent、后台自主 Turn、跨目录 Fork/Rollback | 权限切换可能重启原生连接；恢复时可能替换不可用 Model，不能复活旧 Thinking |
| Grok | ACP 加扩展；审批、压缩、Credits、Fork/跨目录 Fork/Rollback | Permission Mode 在 Session 创建时固定，不能通过恢复后的普通配置写入补设 |
| OpenCode | SDK/Server 事件流；固定 `/compact`、审批、提问、Diff、Fork/Rollback，不支持跨目录 Fork | 原生权限 API 有累加语义，恢复须尊重原生实际状态，不无条件重放旧权限 |
| DeepSeek Harness | 公共 Adapter 内选择 Legacy/Modern；Modern 有控制状态确认、自主 Turn、导入和托管 Web | 两代协议能力不同；原生状态确认、事件关联、历史与认证须留在插件 |
| Antigravity | CLI `stream-json`；配置、工具、文件变化投影、Credits；不支持 Fork/Rollback | Adapter 自持历史补充记录及恢复逻辑；不得迁回 Host 或在重构时删除 |

原生会话和恢复适配归插件负责，不意味着所有 Harness 都有可直接读取的完整原生 Transcript。Host 不建立第二份完整正文事实源；插件可以为自身恢复语义维护必要的私有记录。

### 2.1 当前已有的良好边界

- [`HarnessAdapter / HarnessSession`](../packages/harness-adapter/src/text-session.ts)：统一打开、检查、执行、输出、快照与关闭。
- [`HarnessId`](../packages/shared-contracts/src/ids.ts)：带品牌类型的非空字符串，不是必须逐项扩充的固定枚举。
- 各 `packages/adapters/*`：大部分原生协议、SDK 和历史实现已独立。
- [`CodexTurnProjector`](../packages/protocol-core/src/codex-ui-projector.ts)：消费公共事件，不需要为插件重新实现一份 Desktop 投影。
- Model、权限、Usage、Credits 和命令控件已有通用实现，主要缺口在外围编排与数据来源。

### 2.2 静态注册与展示耦合

当前存在多份外部 Harness 知识：

- 基线中的 `adapter-composition.ts`：静态 import、构造参数、特定预取和 Claude Broker 选择。该模块现已删除，加载路径见 [`installed-harness-plugins.ts`](../packages/host-runtime/src/installed-harness-plugins.ts)。
- [`model-routing.ts`](../packages/protocol-core/src/model-routing.ts)：固定名单、专用 Transport Model 常量和分支。
- [`agent-selection-state.ts`](../packages/renderer-extension/src/agent-selection-state.ts)：固定 Agent union、`piModel`、`claudeModel` 等状态字段。
- [`versioned-renderer-adapter.ts`](../packages/renderer-extension/src/versioned-renderer-adapter.ts)：Renderer 侧重复维护专用编码。
- [`renderer-binding-probe.ts`](../packages/renderer-extension/src/renderer-binding-probe.ts)：ownership 恢复、Credits 白名单与 Claude 偏好。
- [`renderer-agent-picker.ts`](../packages/renderer-extension/src/renderer-agent-picker.ts)：安装地址；相关图标模块维护名称与资源。
- [`production-controller.ts`](../packages/desktop-control/src/production-controller.ts)：再传入一份固定 Agent 列表。
- [`build-release.mjs`](../packages/host-runtime/scripts/build-release.mjs)：固定 Adapter/SDK 必须打入 Host Bundle。

这类信息应改为插件描述和运行时目录，而不是集中复制到另一份公共静态注册表。

### 2.3 恢复策略泄漏

[`external-thread-runtime.ts`](../packages/host-runtime/src/external-thread-runtime.ts) 的恢复路径按名称处理：

- Grok：将持久化权限传入 `open({ kind: "resume" })`。
- 部分其他 Harness：打开后调用 `permissionMode.select`。
- OpenCode：跳过上述权限重放。
- OMP/OpenCode：将实际配置重新编码并保存，避免下次恢复使用过期 token。

这些分支保护真实行为，不能直接删除。相关断言见 [`external-thread-runtime.test.ts`](../packages/host-runtime/test/external-thread-runtime.test.ts)。迁移应把“怎样恢复”交给插件，Host 保留状态验证和映射管理。

### 2.4 可选能力尚未贯通

**Session Import：**本地共享 RPC、Host Importer 和设置页面已通用化，Pi 与 DSH Modern 共用同一路径。Adapter 通过 `listCandidates()` 提供元数据，通过 `resolveCandidate(id)` 重新验证完整原生引用；Host 保留去重、并发、忙碌检查与临时记录清理。远程和 CC Broker 导入尚未扩展，见[当前导入契约](harness-session-import.md)。

**Credits：**Host 通过结构探测读取 `credits()`、`refreshCredits()`，它们不是正式 Adapter 成员。Renderer 还通过 Codex/Grok/Claude 名单决定是否等待 Credits，而 Antigravity 也有对应方法。这是能力提供与消费的双重接线，不等于本轮已证明具体 UI 故障。

**本地化：**公共 `permissionModeScope: "atCreate"` 已存在，但相关提示仍写死 Grok；原生权限标签和说明还有公共翻译映射。

### 2.5 外围耦合

- [`run-host-runtime.ts`](../packages/host-runtime/src/run-host-runtime.ts) 显式预取 Claude/Antigravity 目录。
- [`harness-broker`](../packages/harness-broker/src/protocol.ts) 的描述、客户端与服务端实际限定 Claude Code，不是已经通用的插件进程协议。
- [`delegation-skill.ts`](../packages/host-runtime/src/delegation-skill.ts) 包含 `.claude` 安装位置。
- [`remote-host-install.ts`](../packages/host-runtime/src/remote-host-install.ts) 存在 `claudeCommand` 专属配置。
- 发布脚本维护各原生 SDK 与许可证。

因此本地聊天动态化不等于完整插件化，远程、委派、环境和生产分发都须纳入范围。

### 2.6 修改历史说明的问题

| 提交 | 主题 | 架构启示 |
| --- | --- | --- |
| `7247264` | Grok 创建时固定权限，涉及 37 个文件 | `permissionModeScope` 是合理公共语义，但原生恢复步骤不应由 Host 按名称决定 |
| `f73214a` | OpenCode 使用实际权限恢复 | 恢复不是无条件重放历史配置 |
| `1471d3e` | OMP 权限交互，连带修改两端路由 | 专属参数排列使新增能力扩散到公共接线 |
| `8bfb946` | 提取可选会话导入发现 | 底层接口通用化后，上层 RPC 和 UI 仍需要贯通 |
| `3865276` | Antigravity 历史恢复移入 Adapter | 私有历史适配回归插件是可沿用的方向 |

并非每次由单个 Harness 触发的公共修改都错误。关键是新增概念是否属于公共产品行为，还是泄漏了某个原生系统的操作细节。

## 3. 目标层次与依赖方向

```text
┌──────────────────────────────────────────────────────────┐
│ codexhost 公共层                                         │
│                                                          │
│ Desktop 集成 / 通用 Renderer                             │
│ Thread / Turn / 委派 / 映射 / 公共事件投影                │
│ 通用 Session Import / 配置 / Usage / Credits              │
│                         │                                │
│                Plugin Loader + Registry                  │
└──────────────────────────────────────────────────────────┘
                          │ 只认识稳定契约
══════════════════════════╪═════════════════════════════════
                          │ 读取已安装插件
┌──────────────────────────────────────────────────────────┐
│ plugins/                                                 │
│                                                          │
│  pi/              claude-code/       another-harness/     │
│  manifest.json    manifest.json      manifest.json        │
│  entry.mjs        entry.mjs          entry.mjs            │
│  assets/          assets/            assets/              │
│  原生实现/依赖    原生实现/依赖      原生实现/依赖         │
│  私有恢复/兼容    私有恢复/兼容      私有恢复/兼容         │
└──────────────────────────────────────────────────────────┘
```

图中的目录是逻辑结构，不固定最终安装路径，也不要求插件打成单文件。源码仍可先留在现有 Adapter 包中，通过插件入口包装，避免无意义的批量移动。

依赖方向：

```text
核心 ───────→ 公共插件契约 ←─────── 各插件
Renderer ──→ 浏览器安全的展示与传输契约
各插件 ────→ 各自原生 SDK、CLI、私有恢复与兼容实现
```

Registry 负责描述、身份查找和实例生命周期，不负责 Turn 编排。Loader 负责发现、校验和模块加载。二者可以是同一职责包内的模块，不为形式统一预先增加多个独立服务。

## 4. 职责归属

| 内容 | 公共层 | 插件 |
| --- | --- | --- |
| 名称、图标、安装链接、专属文案 | 通用渲染和资源校验 | 提供元数据与资源 |
| Native Session 生命周期 | 调用与验证公共契约 | 原生创建、恢复、Fork、Rollback |
| 配置恢复 | 传递上下文、维护公共视图 | 决定原生读取、补设、重启与确认步骤 |
| Thread 与映射 | 身份、唯一性、事务、清理 | 不直接访问映射库 |
| 历史 | 公共读取、Turn 对齐和投影 | 原生读取、私有记录与恢复 |
| 审批、提问、工具 | 关联和 Desktop 投影 | 原生事件与响应转换 |
| 命令 | 目录展示、调用、Turn 编排 | 命令目录、校验和原生执行 |
| Session Import | 去重、并发、映射提交 | 候选发现、原生身份和可用性解析 |
| Credits | 类型化快照和通用控件 | 原生采集、缓存与刷新 |
| Web UI | 受控打开与通用入口 | 原生地址、认证和可用性 |
| 旧格式 | 通用兼容分派 | 本 Harness 的解析和迁移 |
| 平台进程设施 | Rust/platform 拥有原生管理 | 选择所需连接方式和插件侧通信 |

公共层保留业务，不是无条件转发器。合理的分支是“能力只允许创建时设置”；不合理的分支是“它是 Grok，所以这样操作”。

## 5. 插件发现、描述与生命周期

### 5.1 发现与启用

建议支持应用资源中的预装插件目录，以及用户数据中的安装目录，两者使用同一加载流程。最终目录名和配置格式在实施时确定；初版也可以仅支持一个明确目录。

- 不扫描任意项目目录并自动执行代码。
- 发现插件不等于信任或启用插件。
- 使用显式启用配置；同 ID 冲突明确拒绝或要求选择，不能按扫描顺序静默覆盖。
- 初版启动时加载、重启生效，不做活动 Session 热替换。
- 禁用或移除插件不删除 Thread、Native Session 或插件私有数据。
- 预装插件使用同一契约，不保留特殊内置执行通道。

### 5.2 静态描述示例

以下仅说明所需字段职责，不冻结最终公共接口：

```json
{
  "manifestVersion": 1,
  "id": "example-harness",
  "name": "Example Harness",
  "version": "1.0.0",
  "adapterApiVersion": 1,
  "entry": "./entry.mjs",
  "icon": "./assets/icon.png",
  "links": {
    "documentation": "https://example.com/docs",
    "installation": "https://example.com/install"
  }
}
```

Manifest 描述身份、资源与契约兼容性，不复制全部运行时能力。安装状态、Model/权限目录及会话能力继续由 `inspect()` 和 Session 提供；DeepSeek 的协议代际与 Model 相关选项证明静态声明不足以代表真实能力。

### 5.3 主动加载，而非全局自注册

```text
读取描述 → 校验兼容性与路径 → 加载已启用入口
        → 调用工厂 → 校验 Adapter 身份 → 注册实例
```

插件入口返回 `HarnessAdapter`，由 Loader 显式注册，禁止通过模块导入副作用写隐藏全局注册表。工厂上下文只提供确有需要的配置、运行环境和受控服务，不传入整个 `AppServerHost`、映射库或 Renderer 控制对象。

插件版本与公共 API 版本分别管理。公共契约需要独立版本和兼容规则，不能把当前 Workspace 的 `0.0.0` 视为成熟插件发布协议。新接口应有运行时校验，不只依赖 TypeScript。

### 5.4 实例作用域与性能

插件描述可以缓存，但不能把现有每 Host/连接的 Adapter 生命周期无条件改成进程级单例。需保留 Native Session、工作目录、环境、远程连接和关闭责任的现有作用域。

目录枚举只读取描述，不为每个插件创建用户 Session。加载、检查和预取需要明确的并发与超时边界，不能让一个插件的慢检查阻塞官方 Codex 或其他插件。已有特定预取可归入插件创建后的非阻塞初始化，但必须维持关闭和错误可观察性。

进程内异常和返回值错误可以在调用边界处理；同步死循环或进程崩溃不能靠 Promise 超时隔离。进程外承载可后续按真实需求引入，不把进程内插件宣传为故障或安全沙箱。

### 5.5 安全与资源

- 插件属于受信任执行代码；安装来源与启用需明确，目录化不等于隔离。
- 校验解析后的入口和资源路径，包括符号链接，防止逃出允许根目录。
- 限制描述、图标、文本和运行时响应大小；优先受校验的图片格式，不执行资源中的脚本。
- Renderer 通过受控资源传输获取图标，不读取任意本地文件或加载插件 Node.js 入口。
- 不向 Renderer 返回私有运行环境、认证凭据或原生端点秘密。
- 未识别、未安装或不兼容的外部插件应明确不可用，不能降级到官方 Codex。

## 6. 公共执行契约与配置恢复

### 6.1 保留现有强类型主干

继续使用 `HarnessAdapter / HarnessSession`、`HostEvent / HostInteraction`、Native Session/Turn/Checkpoint 引用与错误语义。不为了插件化把强类型事件替换为任意 JSON。

create、resume、Fork、Rollback 的产品约束和原生实现仍需区分。Host 可以校验“Rollback 只移除一个 Turn且保留配置”，但不应按 Harness 名称选择恢复步骤。

### 6.2 统一恢复输入和结果，不统一原生步骤

建议在恢复输入中明确区分历史配置提示与用户的新配置指令。概念示例：

```ts
adapter.open({
  kind: "resume",
  nativeRef,
  cwd,
  knownTurnRefs,
  configurationHint,
});
```

`configurationHint` 是设计占位名称，不是现有接口。它不是强制覆盖指令，也不授权提升权限。对应插件须保留自身现有策略：

- Grok 在打开时恢复固定权限基线。
- OpenCode 尊重原生实际权限，不重放累加设置。
- OMP 处理实际 Model 回退、权限恢复与必要的连接重启。
- Claude 等插件接管此前 Host 为其执行的配置恢复步骤。

Host 接收已确认状态并维护公共配置视图，不能生成虚假的 effective 状态。对旧数据的读取和回填应可兼容，而非一次性批量重写。

### 6.3 状态完整性必须明确

必须区分：

1. 状态尚未确定，字段缺失代表未知；
2. 已确认状态不再有某配置，例如当前 Model 不支持 Thinking。

不能把未知直接当清空，也不能在已确认无 Thinking 时从旧配置补回。实施前需用最小类型表达明确这两种情况，并核对 `initialState`、状态事件和快照的一致性，不能再靠某个 Harness ID 修补。

## 7. 路由、配置数据与旧格式兼容

### 7.1 新路由使用统一版本化载体

公共载体表达：版本、Harness ID，以及可选 Model、Thinking、Permission Mode。编码实现应浏览器安全，由 Renderer 与协议层共用；不再新增每 Harness 参数排列。

结构解码成功不代表插件已安装或请求合法。Host 仍须校验 Registry、Thread ownership、当前能力和原生有效选项。

明确属于外部 Harness 的未知、失效或非法载体必须报错，不能因为解码失败就交给官方 Codex。非 codexhost 路由的官方请求保持原行为。

### 7.2 旧格式跟随插件

已有 Thread 的映射提供 `harnessId`，Host 按身份找到插件，由插件解释其旧载体和恢复信息，返回公共结构化结果。Renderer 不再解析七种插件私有历史格式。

若需兼容尚未绑定 Thread 的旧创建请求，可由插件声明旧前缀与受约束解码入口；Loader 校验命名空间和前缀冲突，公共路由只分派，不内置旧 Harness 名单。

最终不能把专属代码藏进公共 `legacy-harnesses` 模块。迁移期间如需暂存兼容分支，应标记范围和退出条件，不成为新插件可继续扩展的入口。

### 7.3 持久化与卸载

- 保持已有 Harness ID、Thread ID 和 Native Session 引用身份稳定。
- 核心只解释公共引用结构，插件解释原生 opaque 内容，禁止按原生 ID 文本猜测 Harness。
- 插件缺失时保留记录，展示通用不可用状态；重新安装兼容插件后恢复。
- `transportModelId` 长期回归 Desktop 路由载体，不继续承担唯一配置存储；结构化配置可渐进引入。
- 插件私有记录使用受管理的独立数据位置，不能借此建立对 Host 内部存储结构的依赖。
- 需要升级数据格式时单独设计兼容和回退，禁止不可逆迁移与执行逻辑调整同时无保障切换。

## 8. 可选能力与专属扩展

先补齐已有真实能力，不预建大型通用操作引擎。

| 能力 | 目标 |
| --- | --- |
| Commands | 静态目录通过 `adapter.commandCatalog` 提供，不启动 Session 或请求原生命令发现；执行沿用 `session.commands`，保留参数、忙碌校验、Turn/Item、取消和临时历史语义 |
| Credits | 正式可选接口；沿用 `AccountCreditsSnapshot`，明确缓存读取、刷新、未知和失败状态，去除结构探测与 Renderer 名单 |
| Session Import | 插件发现候选并提供正确原生引用；Host 通用导入、去重、并发和映射提交 |
| Web UI | 沿用可选入口；插件处理原生地址、认证与可用性，公共层受控打开 |

### 8.1 Session Import 的约束

导入不是普通 Session slash command：操作发生在目标 Thread 建立之前。不能强行包装成用户文本 Turn，也不能让插件直接写映射库。

当前 list 候选只包含浏览器安全元数据，导入时由 `resolveCandidate(id)` 返回新鲜 `{ candidate, nativeRef }`。完整 Native Session 引用由插件确认，Host 不猜测原生格式，也不接收 Renderer 提供的 locator。此只读解析入口不承担 prepare/commit/rollback 事务；映射提交仍属于 Host。

保留重新校验候选、忙碌拒绝、重复导入幂等、跨请求竞争处理和失败清理，不因通用化降低这些保证。

### 8.2 不承诺任意 UI 零修改

“新增 Harness 不改 Renderer”适用于现有公共交互表达范围。普通专属命令通过命令目录，复杂专属页面通过 Harness Web UI；全新的公共交互形式仍可能需要公共契约和控件演进。

不靠开放任意 JS/DOM 操作换取无限扩展。也不把审批、导入、权限等已有强语义能力扁平化为任意 method。

命令实现继续参考 [Harness Command Integration Guide](harness-command-integration.md)。

## 9. Renderer、元数据与远程目录

Renderer 只从当前目标 Host 获取可序列化插件描述、能力和公共状态，不扫描本地插件目录，不加载插件后端代码。

- Agent Picker、名称、图标、安装链接和专属翻译来自插件。
- 草稿和配置按目标 Host 与 Harness ID 组织，不再定义 `piModel` 等字段。
- Model/Thinking/Permission Mode 来自实际检查结果；不可选择 Model 或空目录不能被伪造 Model 绕过。
- Thread 恢复使用 Host 返回的结构化 ownership/configuration，不再逐 Harness 解码。
- 固定权限提示使用通用措辞或插件提供的描述，不在公共文案中写死 Grok。
- Claude 旧权限偏好以受限兼容迁移保留，不能继续作为公共永久分支；迁移方式不得允许插件任意访问其他插件的浏览器数据。
- 本地与远程目录独立，切换 Host 后校验异步响应归属，避免旧请求覆盖新工作区状态。
- 图标与元数据的缓存有明确作用域；元数据可用于说明不可用插件，但不能把缓存当可执行授权。
- Host/Renderer 公共协议仍需兼容，动态插件不代表任意版本天然互通。

## 10. 原生承载、委派与生产分发

### 10.1 原生承载

Claude 直连与 macOS Broker、DeepSeek Legacy/Modern 的选择归对应插件。现有 Claude Broker 可先保留为插件专属承载，不必一次扩大为全 Harness RPC。

Rust 继续拥有原生启动、进程管理、安装与平台集成。若平台设施需要参数化，应使用有限的通用进程/服务描述，而不是让 Rust 理解 Harness 会话或权限语义。

### 10.2 委派

公共层保留独立 Thread、任务关系、后续消息、取消及结果观察。插件负责把委派环境传到原生执行环境，并提供自身所需的发现/集成方式。

当前特定 Skill 目录知识应归插件声明或所属集成；通用文件安装设施继续保留用户文件冲突保护，不能允许描述绕过目录或写入权限。既有递归委派、只读观察与远程环境传播须验证。

### 10.3 分发

- 核心产物不强制包含各 Harness SDK。
- 每个插件包含其可运行依赖、资源、许可证与平台要求；不强制单文件 Bundle。
- 预装集合由发行组合维护，不与核心编译耦合。
- 外部插件安装不要求修改核心的 SDK 白名单；相应审计责任转到插件包与安装信任流程，不能取消安全或许可证检查。
- 验证实际安装产物，而非只在 Workspace 符号链接和开发依赖齐全的环境中运行。
- SSH、Remote Control、CLI discovery 和 Node.js 运行环境纳入测试；不能只验证本地路径。

## 11. 行为保持的硬约束与风险

### 11.1 发布硬约束

1. 不削减各 Harness 已支持的流式、工具、Diff、审批、提问、取消、历史、配置、Usage、Subagent 或委派行为。
2. 不以统一形式改变原生传输、权限基线和执行策略。
3. 不伪造能力、有效配置、Native identity 或历史 Checkpoint。
4. 不将未知或不可用外部 Thread 路由给 Codex。
5. 不改变 Thread 固定归属一个 Harness 的规则。
6. 不因插件移除清理用户历史和原生数据。
7. 不在兼容验证前切换默认发布路径。

### 11.2 特别风险

| 风险 | 依据与控制 |
| --- | --- |
| 恢复统一成重放配置 | 会破坏 Grok/OpenCode/OMP 已有差异；迁移原策略并用已有断言保护 |
| 能力声明不完整 | Claude/OMP 有自主 Turn 输出，但所检查声明未完整包含对应字段；先核对实现与声明，不直接按静态声明过滤事件 |
| 承载模式能力不一致 | Claude 直连有 Credits，Broker 当前无对应转发；按模式冻结现状，不把未实现能力算作回归 |
| 原生状态字段含义变化 | 区分未知与确认缺失，防止旧 Thinking/权限复活 |
| 导入逻辑移入插件 | 会泄漏 Host 事务；发现归插件，映射与竞争处理留 Host |
| 旧编码与偏好丢失 | 专属兼容随插件保留，使用旧数据夹具验证 |
| SDK 在产物中缺失 | 对独立安装包和平台资源测试，不能只跑开发源码 |
| 插件异常影响全宿主 | 受信任加载、边界校验与清理；进程内无法承诺隔离崩溃或阻塞 |
| 专属能力变成万能 JSON | 保留强类型公共主干，先用现有可选能力 |

“不影响能力”并不只指最终能回复文本。配置持久化、事件顺序、工具交互、历史精度、身份、进程清理、错误语义和启动阻塞都属于基线。

## 12. 分阶段迁移计划

每阶段独立检查行为等价，不等全部重构完成后再集中验证。下表是工程实施计划，不是已完成任务或人机安装向导。

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| 0：建立基线 | 按七个 Harness、原生版本、协议代际与承载模式记录实际能力、限制、测试和实机需求 | 明确受保护行为；声明缺口与已有问题单独记录 |
| 1：统一描述与工厂 | 为现有 Adapter 提供相同插件入口和描述；保留原生实现与现有分发 | 注册方式变更不改变执行；无须立即拆包或移动所有源码 |
| 2：收回恢复与能力泄漏 | 迁移恢复策略；正式化 Credits；通用化 Session Import；保留原事务 | Host 不按外部 Harness 名称选择原生策略；各行为测试仍成立 |
| 3：目录与路由动态化 | 通用编码、插件兼容读取、Renderer 状态与展示、Controller 启用机制 | 新 ID 不增加生产名单、编码 switch、图标映射或专属偏好分支 |
| 4：独立分发与外围归位 | 独立插件包、版本校验、受信任目录、Broker/委派/远程配置归位 | 核心不依赖具体包；安装产物和远程路径可验证 |
| 5：仓库外验收 | 接入源码中不存在的插件，测试缺失、冲突、不兼容及全能力回归 | 核心和 Renderer 零改动接入，受保护行为全部通过发布门槛 |

实现中若发现必须修改原生投影或权限语义，应单独说明原因、风险和验证，不把它隐藏为机械迁移。临时兼容分支应有退出条件，避免长期维护两条生产执行路径。

### 12.1 回退要求

- 优先保持旧数据格式可读，不做大规模不可逆转换。
- 每阶段能够通过代码回退恢复上一步，而不是并行执行两套 Adapter 导致重复 Turn。
- 如果新写入格式不能被旧版本读取，应在启用前提供明确的版本回退方案和数据兼容测试。
- 安装/启用插件失败不破坏上一份可用配置或正在使用的数据。

## 13. 验证与验收

### 13.1 三层验证

| 层次 | 内容 |
| --- | --- |
| Adapter 与契约 | 回放确定性的原生输入，比较命令接受、事件顺序、交互关联、状态、快照、错误和关闭；仅规范化非语义性随机值 |
| Host / Renderer | 路由、归属、能力控件、配置、旧数据、映射事务、失败恢复和异步 Host 切换 |
| 产物与实机 | 真正的插件安装、私有依赖、原生版本、认证环境、平台进程及远程运行 |

不能以真实 Model 回复逐字相同衡量等价，也不能只依赖 Mock、最终文本或能力布尔值。测试存在不代表已运行；每次验收记录命令、结果、跳过项与原因。

### 13.2 必须覆盖的回归场景

- 每个 Harness 的检查、创建、后续 Turn、恢复、取消、错误和关闭。
- 所有已支持的工具、Reasoning、Diff、审批、提问及响应。
- Grok 固定权限在恢复与相关历史操作中保持原义。
- OpenCode 不错误重放权限；原生配置确认失败不发布虚假状态。
- OMP Model 回退、缺失 Thinking、权限重启失败恢复、Subagent 和后台自主 Turn。
- Claude 本地与 Broker 模式的现有行为、交互回调及后台延续。
- DeepSeek Legacy/Modern 分别验证；Modern 状态确认、事件关联、导入竞争与忙碌检查。
- Antigravity 历史补充记录、重启恢复与受支持文件变化展示。
- 各 Harness 支持的精确 Fork、跨目录限制、Rollback 与稳定 Turn/Checkpoint 身份。
- Usage/Credits 未知、刷新、失败与 Thread/Host 切换不串用数据。
- 命令目录、文本参数、执行、取消、临时 Turn 和历史持久化差异。
- 委派创建、后续消息、取消、观察和递归环境传播。
- 所有旧 Thread、路由与偏好仍可读取，插件缺失时明确不可用。
- SDK 资源、Node.js 环境、SSH/Remote Control、进程退出与清理。

### 13.3 架构验收

- [ ] 公共生产代码不存在对具体外部 Adapter/SDK 的依赖。
- [ ] 公共运行逻辑不存在按具体外部 Harness ID 选择策略的分支。
- [ ] Renderer 不维护外部名单、专用状态字段、安装链接或旧编码实现。
- [ ] 具体旧格式和偏好兼容归插件，不藏在公共兼容总表。
- [ ] 无外部插件时核心与 Renderer 仍可构建运行。
- [ ] 仓库外插件通过安装配置接入，无核心与 Renderer 修改或重建。
- [ ] 重复 ID、无效描述、不兼容版本、未知路由、插件缺失和加载失败有明确结果。
- [ ] 插件失败不误路由、不删除数据；可清理的资源按契约关闭。
- [ ] 本地与远端插件目录独立，公共协议兼容要求明确。
- [ ] 原生行为基线和实际安装产物验证完成；未完成项不能被报告为通过。

检查可采用依赖图、导入限制、针对性的源码检查和仓库外测试，不以全仓库禁止 Harness 名称替代架构验证。

## 14. 收益、成本与取舍

| 维度 | 收益 | 成本或风险 |
| --- | --- | --- |
| 新增 Harness | 修改范围集中在一个插件 | Loader 与运行时校验增加 |
| 原生升级 | 可独立发布插件，核心不必随 SDK 变动 | 核心 API、插件与原生版本需要兼容管理 |
| 问题定位 | 原生策略与测试集中，减少跨包追踪 | 运行时加载问题无法全部靠静态编译发现 |
| Renderer | 新名称、资源、目录和既有交互不需专用接线 | 必须完善目录、资源、缓存和异步作用域 |
| 远程 | 每个 Host 按自己安装情况提供能力 | 多承载模式的验证矩阵扩大 |
| 安全与分发 | 明确信任与资源边界、减少核心 SDK 集合 | 独立包审计和安装责任增加 |
| 迁移 | 长期减少耦合和漏接 | 短期是跨包工程投入，并非简单减少代码量 |

建议保留静态方式作为迁移中的已验证起点，不把它作为最终扩展机制。仅建立一个公共静态注册表，无法满足核心零修改接入；万能 hook/RPC 虽能减少显式名称，却会削弱类型、生命周期和安全约束；强制全插件进程外运行则会新增序列化和承载成本，当前不宜作为首要前提。

最终推荐：描述式发现与注册、稳定强类型会话接口、有限且真实的可选能力、插件内部原生策略。公共契约仍可因产品级语义演进而变化，但不能因为新增一个现有类型的 Harness 或专属命令而反复接线。

## 15. 实施前仍需收敛的事项

以下是接口与验证工作，不表示需要推翻目标架构：

1. 最终插件根目录、启用配置及冲突处理格式。
2. Manifest/API 版本兼容范围与公共契约包的发布方式。
3. 恢复提示和“未知/确认缺失”状态的最小类型表达。
4. 导入候选到完整 Native Session 引用的确认方式。
5. 正式 Credits 接口的刷新、缓存和状态语义。
6. 旧路由、浏览器偏好和资源传输的受限兼容机制。
7. 各 Host/连接的 Adapter 实例作用域与初始化性能基线。
8. Claude Broker、委派发现和远程配置的插件化接口范围。
9. 七个 Harness 按协议代际、承载和原生版本的实机验证条件。

这些事项收敛前，不承诺具体文件数量、工期或零回归。只有实现、契约、测试、安装产物和文档一致，才能宣告迁移完成。

## 16. 相关文档

- [领域术语表](领域术语表.md)
- [Harness 命令集成](harness-command-integration.md)
- [Harness CLI 发现](harness-executable-discovery.md)
- [ACP 后续抽取边界](acp-layer-follow-up.md)
- [SSH 远程 Host](remote-ssh-host.zh-CN.md)
- [Remote Control Host](remote-control-host.zh-CN.md)
