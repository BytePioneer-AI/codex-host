# Harness 插件运行时：动态加载与预装发行

> 状态：16 个预装 Harness 和用户目录插件统一动态加载，Host 使用 Cordis 管理插件生命周期，Renderer 按目标 Host 目录展示；**完整周边去专属化及原生验收尚未完成**。本文描述当前代码，不替代[架构与迁移方案](harness-plugin-architecture.md)。

## 当前范围

当前源码启动路径可以加载原先不认识的外部 Harness ID，通过 `codexhost/harness/plugins/list` 返回描述，并通过公共 Harness 检查接口和 `thread/start` 调用该插件。

16 个预装 Adapter 通过同样的 `manifest.json` 和 `createHarnessAdapter` 工厂加载；`adapter-composition.ts` 已删除，Host 源码、包依赖和 TypeScript references 不再直接引用具体 Adapter 包。预装集合仅由发行清单 [`scripts/release/harness-plugins.json`](../../scripts/release/harness-plugins.json) 决定。原生构造参数、预取和 Claude Code 的直接/Broker 选择仍由相应插件负责。

本地会话导入已使用公共 `sessionImport` 契约、Host 映射事务与动态设置页；Claude Code、Pi、Hermes 和 DSH 已提供实际实现。DSH 通过本机托管 Web 接入，只对接 V4；`0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` / `0.2.0-rc.2` 已通过对应验证，低于 `0.1.7-rc.1` 的版本明确拒绝，其他 SemVer 版本可尝试连接，但仍须通过原生协议校验。Legacy 协议与 V0/V3 已移除。完整原生引用只在 Adapter 与 Host 间流转，详见[会话导入](harness-session-import.md)。普通 Agent Picker、Sidebar 和连接设置也读取同一 Host 的插件描述，不再内置外部 Harness 名单或图标。

尚未实现的目标包括：

- 清理 Credits 重试和 Pi 凭据导入等周边专属逻辑；这些仍不等同于通用插件扩展点。
- 完成旧协议载体迁移的原生验收。新请求统一写入共享插件载体；旧载体仍只读兼容，不能直接删除其解码器。
- 会话 Credits 旧 duck-typed 路径的统一迁移、远程/Broker Session Import 接入、插件拥有的旧数据迁移。设置页已有公共只读账号额度接口（见下文），不代表所有 Credits 路径已迁移。
- 插件独立发布/升级/依赖安装机制，以及 Broker、远程配置和委派周边的完整去专属化。现有 npm/Installer 发行已携带独立插件 Bundle 和应用资源预装目录；Broker 协议和 CLI 入口仍保留现有 Claude Code 语义。
- 原生 Harness、历史版本、协议代际、远程执行及安装产物的完整行为验收。

因此不能据此宣称“公共层已经不认识任何外部 Harness”或“全部原有行为零回归”。

## 目录和显式信任

Host 每个连接使用同一个加载器读取两类根目录：

- **预装目录**：实际执行的 Host Runtime 文件旁的 `plugins/`，不依据当前项目 cwd 猜测。源码构建位于 `packages/host-runtime/dist/plugins/`；发行产物位于 `app/plugins/`。
- **用户目录**：选择顺序为：

1. `CODEXHOST_PLUGIN_DIRECTORY`；必须为绝对路径，否则拒绝该根目录。
2. 设置了 `CODEXHOST_DATA_DIR` 时，使用其解析后的绝对路径下的 `plugins/`。
3. 否则使用 `~/.codexhost/plugins/`。

目录结构为：

```text
plugins/
├── enabled.json
└── sample-agent/
    ├── manifest.json
    ├── dist/
    │   └── plugin.js
    ├── assets/
    │   └── icon.svg
    └── …插件自身实现和可解析的运行依赖
```

`enabled.json` 是本机管理员或用户授予的执行许可，不是发现缓存：

```json
{
  "version": 1,
  "enabled": ["sample-agent"]
}
```

每个根目录都有自己的 `enabled.json`。发行版生成预装目录的启用文件，作为对随包交付插件的显式信任；用户目录由用户配置。发现但未启用的插件不执行，也不进入目录查询结果。缺少某个根目录或其 `enabled.json` 时不加载该根目录插件；配置无效时拒绝该根目录，不回退到硬编码内置实现。不扫描项目目录，不自动安装或下载依赖，不热替换。

用户目录不是覆盖层；两个根目录出现相同 ID 时，两份候选都拒绝加载。用户 `enabled.json` 也不用于修改预装根目录的启用集合。

**启用的插件是可信本机代码，不是沙箱代码。** 工厂在 Host 进程内运行，具有该进程的权限，并能读取传入的环境变量，包括其中可能存在的凭据。路径和元数据校验不能防止可信插件主动导入其他文件、访问网络、调用 `process.exit` 或阻塞事件循环；也不提供对本地恶意并发文件替换的隔离保证。

## Manifest 与工厂

最小完整描述示例：

```json
{
  "manifestVersion": 1,
  "id": "sample-agent",
  "name": "Sample Agent",
  "version": "1.0.0",
  "adapterApiVersion": 1,
  "entry": "dist/plugin.js",
  "icon": "assets/icon.svg",
  "links": {
    "documentation": "https://example.com/docs",
    "installation": "https://example.com/install"
  }
}
```

- ID 为最长 128 字符的小写可移植标识；`codex` 保留给官方路径。
- `manifestVersion` 当前为 `1`；`adapterApiVersion` 与 Host 的整数 API 版本精确匹配。尚未采用版本范围协商。
- `entry` 是插件内的 `.js` 或 `.mjs` ESM 文件；`.js` 需要按 Node.js ESM 规则声明所属包。Manifest 不负责安装依赖。
- 资源只能是插件内部相对路径；拒绝目录遍历和解析后逃出根目录的符号链接。
- `links.website/documentation/installation` 只接受不带用户凭据的 HTTPS 地址。
- `installation` 提供展示用命令、下载链接和前后提示；`notice` 提供插件兼容性说明。文本以 `en` 为必需回退、`zh-CN` 为可选翻译。Renderer 仅展示/复制这些数据，绝不从元数据执行命令，自动安装仍走 Adapter 的公共原生能力。
- 能力继续由 `HarnessAdapter.inspect()`、Session 能力和公共可选接口提供，不在 Manifest 复制第二份运行时能力真相。
- 命令目录由可选的静态 `HarnessAdapter.commandCatalog` 声明，通过 `codexhost/harness/commands/inspect` 查询；读取目录不检查原生运行时、不连接原生服务、不创建或恢复 Session。未声明时返回空目录，不通过启动会话回退发现。执行仍走 `session.commands`。

入口导出 [`HarnessPluginModule`](../../packages/harness-adapter/src/plugin.ts) 定义的工厂，不通过模块全局副作用注册：

```ts
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { SampleAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext) {
  return new SampleAdapter({ environment: { ...context.environment } });
}
```

这里的 `SampleAdapter` 代表插件自行实现的 [`HarnessAdapter`](../../packages/harness-adapter/src/text-session.ts)，不是仓库提供的类。返回对象的 `harnessId` 必须与 Manifest 一致；工厂可异步返回，每个 Host 连接分别创建实例。Node.js 仍缓存模块，模块级可变状态不会自动按连接隔离。Claude Code 获取用户 Shell 环境使用异步子进程，保留 3 秒超时，避免同步等待阻塞 Host 事件循环。

插件可以额外导出可选的 `warmup(adapter): Promise<void>`。Host 调用它进行尽力而为的后台预取，不等待其完成后才服务请求；失败只记录稳定诊断码。当前 Claude Code 和 Antigravity 使用这个入口，其他插件无需为统一形式添加空实现。预取创建的原生资源也由 Adapter 的幂等关闭负责。专用运行时可以请求不预取的冷实例。

Context 包含环境变量快照、平台、是否为受管远程 Host，以及可选 Broker 描述符路径和本地页面服务。目录加载时环境快照被冻结；它不是凭据过滤器。`openLocalUrl` 经过 Native Launcher 的 loopback URL 校验，在系统浏览器打开页面。`openLocalPage` 通过既有认证 Controller 连接打开 Codex 内置浏览器的后台页面，返回 `show/close` 句柄；插件按请求持有并关闭它，连接断开也会释放所属页。该页面接口仅接受带显式端口的 `http://127.0.0.1/` 根地址，不向聊天页注入第三方脚本；需要当前可见的本地任务及可用的内置浏览器。受管远程 Host 不提供这两项本机服务。

## 自定义启动路径设置

连接设置页的本地 Host 右侧详情卡片为声明 `launchCommand` 的插件提供路径输入、保存和清除操作；不对远程/Broker 提供此入口。Manifest 可声明 `launchCommand: true`，该标记同时进入公开插件描述；Host 不维护具体 Harness 的命令变量名单。

`codexhost/harness/launch-settings/get` 接受 `{ harnessId }`，`codexhost/harness/launch-settings/set` 接受 `{ harnessId, path }`；`path: null` 清除设置。返回 `{ path, restartRequired }`。只允许已加载目录中声明该设置的本地插件。保存时校验绝对路径及安装目录存在性，兼容已保存的文件入口，不执行文件，不把保存成功等同于原生协议或认证可用。路径不包含命令行参数或包裹引号。

配置按插件保存到 `${CODEXHOST_DATA_DIR}/harness-launch-settings/<id>.json`，未设置数据目录时使用 `~/.codexhost`；采用临时文件加原子替换，不写 Renderer localStorage，不改进程全局环境。下次 Host 构造插件时，经公共 `HarnessPluginContext.launchCommand` 传给声明支持的工厂。WorkBuddy 工厂将其映射到原生启动配置，优先于继承的命令环境变量；清除设置后恢复环境变量或自动发现。

**修改需要重启 codexhost。** 已创建的 Adapter 与 Session 不热替换；`restartRequired` 比较当前持久化值与此 Host 构造时的值。仅刷新连接状态不会应用新路径。设置页填写应用安装目录，例如 `D:\program\WorkBuddy`，不要求用户定位 `.exe` 或脚本。WorkBuddy Adapter 定位 `WorkBuddy.exe` / `WorkBuddy AI.exe` / `WorkBuddyAI.exe` 及同目录内置脚本。目录布局不完整时检查失败，不借用其他安装的文件，也不回退到 PATH 或默认安装。底层保留原有文件入口覆盖兼容能力。注册表自动发现不在本功能范围内。

## Harness CLI 版本与更新

设置 → 连接，在已安装 Harness 的右侧详情展示「Harness CLI 版本」、当前版本、最新版本与更新按钮。首次选择详情时自动检查一次，不提供手动检查更新按钮；后台诊断刷新和切换列表不会丢弃该页按 Host/Harness 保存的检查结果或重复启动更新。重新打开连接页后再次自动检查。所选 Harness 的详情卡片标题旁提供官网外链图标，列表行及详情正文不重复提供通用官网或安装说明链接。未安装且有自动安装入口时显示下载图标；点击显式发起 CLI 安装，点击行本身查看手动安装命令、复制按钮、接入提示和「重新检测」，正文不提供额外的通用安装指南跳转入口。WorkBuddy 在详情正文提供一个「下载」按钮，跳转官网首页，并提示下载安装桌面应用，不提供分系统的安装指南链接。未支持版本管理能力的插件、旧 Host 和 Broker 路径显示不可用，不回退更新本机的另一份安装。

可选 `HarnessAdapter.installation(action)` 接受 `check` / `update`，由所属 Adapter 决定版本来源、安装渠道和原生更新命令。公共 `codexhost/harness/installation` 只接受 `{ harnessId, action }`，返回 `{ currentVersion, latestVersion, updateAvailable, canUpdate, message?, messageCode?, latestVersionKind? }`。`message` 保留为 Adapter 诊断文本，不在界面原样拼接；内置 Adapter 用 `messageCode` 标识更新限制或渠道说明，Renderer 按当前中英文设置显示。`latestVersionKind` 可标识 `unknown` / `tracking-branch`，避免将非版本状态当成英文版本号展示；真实版本号及提交标识保持原样。旧插件的 `Unknown` / `Tracking branch (new commits)` 仍按当前语言展示，缺少或无法识别提示码时仅显示通用本地化说明，不展示未翻译的诊断文本。Renderer 按连接页选中的 Host 发送请求，Host 等待插件加载后通过公共能力路由；不接受命令、路径、包名或下载地址，不直接依赖具体 Adapter。非法请求返回 `-32602`；单插件未支持返回 `-32078`，不使用会让浏览器缓存整个方法缺失的 `-32601`。原生失败及非法结果统一返回脱敏错误。

DSH 的 npx 更新只在显式点击更新时执行 `npx --yes --prefer-online @deepseek-ai/dsh --version`，保留与普通离线启动相同的无版本包规格及 Host 环境（包括 npm 缓存配置），避免 `@latest` 或固定版本规格创建另一份缓存。先确认在线命令返回目标版本，再用原来的 `--offline --no-install @deepseek-ai/dsh --version` 回读，任一步失败或版本不匹配均不报告成功。版本查询失败不执行更新；普通诊断和启动仍保持离线，不改变现有会话或自动重启已运行的 Web 进程。npm 原生管理缓存，不直接编辑缓存目录，也不新增 Host 持久状态。

### 首次安装

RPC 的 `action: "install"` 调用可选 `HarnessAdapter.install()`，不会把 `install` 传给旧插件的 `installation()`。Host 先刷新检查，只有 `notInstalled` 才安装，避免把未登录或不可用误认为未安装；安装后通过 `installation("check")` 回读 CLI 版本。安装失败或版本无法确认都不报告成功，原生异常脱敏后显示在右侧详情。

- DeepSeek Harness（`@deepseek-ai/dsh@latest`，安装时跟随 npm `latest` 标签；不代表该版本已验证兼容，连接仍须通过原生协议校验）、OpenCode、Grok、CodeBuddy 使用官方 npm 包；需要已有 Node.js/npm；npm 在 PATH 未命中时继续搜索版本管理器与标准安装位置，适配 Desktop 的精简 GUI 环境。Grok 保留 npm 安装脚本允许项。
- Pi、Claude Code、OMP、Antigravity、Kiro CLI、Cursor CLI、Hermes、Qoder 两版和 Kimi Code 使用各自 Adapter 固定的官方 HTTPS 安装脚本，按 Host OS 选择 Shell/PowerShell。脚本下载到临时目录，执行后清理；安装命令最多 10 分钟，不自动提权，不自动安装系统依赖，安装器不能依赖交互输入。
- WorkBuddy 仍引导安装桌面应用。旧插件、旧 Host 和未转发能力的 Broker 返回不支持，不回退到本机安装。
- Host 按 Adapter 合并并发安装，安装期间的检查/更新等待同一结果。Renderer 按连接及 Host/Harness 保存安装状态：列表中显示安装中、检测中或错误，安装时禁用下载按钮，错误保留在右侧并允许重试。切换行、Host 或关闭再打开设置不会取消操作；Host/连接进程重启后不恢复任务。
- 成功和失败后均只重新诊断所选 Host：先等待该 Host 已有诊断结束，再发起安装完成后的新诊断，不能复用安装前的结果；普通后台刷新仍合并并发请求。CLI 安装完成不意味着登录、Provider 配置或所有 Adapter 能力可用。检测结果才决定最终连接状态：即使版本回读失败，只要同一 Host/Harness 的本次重新诊断确认 `ready`，就清除安装失败覆盖状态；其他 Host 的状态或刷新失败后的旧快照不能清除错误。版本回读还可能依赖更新源网络；版本检查失败时应先重新诊断，不盲目重装。

安装路径来自仓库维护的官方指引，并非所有系统/架构已通过真实安装验收。前置依赖、网络、官方安装器交互和平台支持仍影响结果；模拟测试不代表真实安装成功。

当前检查与更新支持：

| Harness | 检查与更新 |
| --- | --- |
| Pi | `--version` 和 `pi.dev/api/latest-version`；执行原生 `pi update`。 |
| Cursor CLI | 原生 `about --format json` / `update`，保留 Windows bundled Node 入口；macOS 受管远程 Broker 尚不转发该能力。 |
| Qoder 海外版 / 中国版 | 原生 `--version`、`update --check` / `update`；两版分别解析自己的安装入口，中国版先确认 CLI 支持 `--check`，旧版只显示已安装版本及手动更新说明。 |
| Grok | 原生 `update --check --json` / `update`；npm 安装保留原生更新路径及所需安装脚本允许项。 |
| Kimi Code | 原生 `--version` 和区域 CDN 最新版本；仅识别的全局 npm 安装或带手动更新能力的原生二进制允许更新，其他安装使用原安装方式。 |
| Antigravity CLI | 原生 `--version` 与按 OS/CPU 的官方更新清单；执行 `agy update`。 |
| OMP | 原生 `update --check` / `update`，保留配置的 stable/canary 渠道；校验原生更新器在 PATH 中选择的目标与所选安装一致，Nix 和目标不一致的自定义入口保留手动更新。 |
| OpenCode | `--version`；npm 安装查询原包版本并更新其准确 prefix，标准 `~/.opencode/bin/opencode` 原生安装查询官方 GitHub Release 并执行 `upgrade <version> --method curl`。其他包管理器、自定义安装和 Windows 原生安装只检查，不进入交互式安装回退。 |
| Claude Code | `--version` 和官方 stable/latest 版本源；读取用户及本机文件型受管设置，使用原生 `claude update` 保留策略执行。识别的全局 npm 安装固定 npm prefix，标准原生 launcher 允许更新；版本限制、其他安装渠道及 macOS 受管远程 Broker 保留手动更新。 |
| CodeBuddy | `--version`；识别的 npm 安装查询 `@tencent-ai/codebuddy-code`，只有全局安装允许在原 prefix 更新。原生安装只显示已安装版本，最新版本和更新交给原安装器；macOS 受管远程 Broker 尚不转发该能力。 |
| Kiro CLI | 只通过 `--version` 显示当前版本；最新版本未知，不检查更新源、不执行更新。Kiro 的更新策略与发布源选择交给原生安装器，设置页提示使用原生更新器或安装方式。 |
| DeepSeek Harness | 原生 `--version`，独立查询 npm `@deepseek-ai/dsh` 的 `latest`，不受安装渠道限制。识别的全局安装更新原 prefix；npx 安装显式更新原缓存并验证离线启动版本。Python wheel、桌面载体及项目安装仍使用原安装方式更新，不创建或更新另一份全局安装。 |
| Hermes | 原生 `--version`、`update --plan`、`update --check`；使用原生渠道判定和提交标识而非普通 SemVer 比较。仅可原地更新且能报告提交标识、支持非交互与 Gateway 重启延后的干净 Git 安装执行 `update --yes --no-gateway-restart`；桌面包、Docker、Nix 等仍由原生安装所有者更新。 |

检查不发起 Model Turn、不安装任何内容。只有用户明确点击更新才调用原生安装器；并发更新合并为一次，检查不与更新后版本回读竞争，安装后版本未改变不报告成功。普通命令有 30 秒超时，更新命令最多 5 分钟，最新版本网络读取有 15 秒超时；失败后可重新打开连接页触发自动检查。更新的是 Harness CLI，不是 Host 插件或 codexhost 自身，不降级较新安装，不主动重启已有 Session。关闭设置只停止页面更新，不取消已接受的原生更新；现有进程的升级行为遵循 Harness 本身。

无法安全检查最新版本的安装返回 `latestVersion: "Unknown"` 和手动更新说明，而非假称与已安装版本一致；Connections 详情显示 Adapter 的说明，不将这种安装标为「已是最新」。npm 识别包含确实指向对应包入口的 Windows shim；版本比较区分预发布标识并忽略 build metadata，避免预发布间更新被漏判或发生降级。

跨包路由、Adapter 的命令映射、安装渠道限制、并发与失败、连接详情的 Host 隔离及页面生命周期有聚焦测试。模拟测试不代表所有安装渠道、平台或真实升级已经通过验收。

## Cordis 生命周期与配置恢复

`host-runtime` 内的 `HostPluginRuntime` 使用精确版本 `@deepseek-ai/cordis@4.0.4`，只负责挂载与作用域释放，不拥有 Harness 业务协议。`HarnessPluginRegistry` 将既有工厂返回的 Adapter 注册为 Cordis effect；卸载 effect 时移除目录项并关闭 Adapter。插件作者仍实现公共 `HarnessAdapter / HarnessSession`，无需依赖 Cordis 或继承 Host 类。

每个 Host 连接有独立 Registry/Runtime；没有进程单例，也不将将来的进程级服务重复实例化到每个连接。只有 Harness 桥接层在本次接入；通知、诊断等插件尚未迁移。Host 先排空请求并关闭 Session/输出消费，再释放插件作用域。关闭幂等，失败收集为 Registry 清理错误。发现、显式信任、超时、迟到资源清理仍由加载器负责，Cordis 不是安全沙箱或包管理器。安装和升级需要重启，不热替换活动 Session。

恢复时，Host 将旧映射解码为 Model、Thinking、Permission Mode 提示并传给 `open({ kind: "resume" })`。Adapter 决定恢复提示还是保留权威原生配置；Host 不再按 Harness ID 补发配置命令。OMP、DSH 在各自 Adapter 内恢复权限；OpenCode 保留原生确认的权限状态。成功读到原生配置后，Host 用共享载体保存确认值，旧映射仍可读取。

## 加载与关闭行为

加载器先校验所有可发现的 Manifest，再导入已启用模块：

- 跨目录的重复 ID 一律拒绝，不按扫描顺序或启用优先级取胜；与显式注入的测试 Adapter 冲突时也拒绝目录候选。
- 不匹配的 API 版本不执行入口，但保留 unavailable Adapter 和公开描述。
- 单插件导入、工厂或资源错误转为 unavailable，不妨碍其他正常插件加载。
- 诊断仅包含稳定错误码和公开 ID，不透传插件抛出的路径、环境值或异常正文。
- Manifest 最大 32 KiB，图标最大 128 KiB，总候选插件最多 128；加载器 API 最多接受 8 个根目录，当前启动组合使用预装和用户两个根目录。
- 最多 4 个加载 worker；每个插件的异步导入和工厂有独立的默认 10 秒超时，后加载的插件不会分到前一个插件剩下的时间。文件系统发现、同步代码和关闭操作不保证可被超时中断。
- Host 先初始化官方 app-server，再后台整体加载已启用插件。涉及外部 Harness 的查询、创建、恢复及委派等待同一批加载完成，不采用按需加载或按 Harness 独立等待，原有同步 Adapter 注册表保持不变。
- Desktop 请求在读取循环之外派发，同 Thread 的请求路由和 Session 打开按接收顺序执行；不同 Thread 及无 Thread 的请求独立处理。命令列表、创建或恢复等待插件时，不阻塞后续官方请求。官方初始化仍在读取循环内完成；运行中 Turn、命令及中断维持原有异步处理方式，不把整个 Turn 串行排队。
- 关闭或 Desktop 输入 EOF 时先取消插件加载，再等待已接收的路由和 Session 打开任务完成，最后取 Session 快照并关闭资源，避免遗漏迟到的 Session。取消后迟到的 Adapter 仍会关闭；未加载或不可用的外部 Harness 不回退到官方 Codex。
- 超时后才返回的 Adapter 会尝试关闭；未返回实例前创建的资源仍须由插件自行负责清理。
- Host 退出时关闭已加载 Adapter；Registry 自身的 `close()` 幂等，并尝试关闭所有实例，即使某个实例同步抛错。
- 外部 Session 输出消费或投影抛错时，Host 关闭该 Session，并用投影器已接受的 Item 状态取消未决交互、收尾活动 Item、将未结束的 Turn 标为失败。非法完成事件不能改变已有 Item 类型，也不能让 Desktop 永久保留运行状态；不伪造原生成功或 Checkpoint，不重写已完成 Turn 的结果。Desktop 已断开时通知只能尽力发送，关闭或通知失败保留诊断。

### 外部 Thread 预热

本机与远程均保留 Desktop 原生的草稿预热；它只提前创建 Session，不发送用户消息。Desktop Control 只给外部、非 ephemeral 的预热 `thread/start` 加上 `codexhostPrewarm: true`，正式创建与官方 Codex 请求不加此标记。配置变更、策略清理或退役时，已返回的外部预热与之后迟到的结果通过 `codexhost/thread/prewarm/discard { threadId }` 请求释放，不能只在前端丢弃结果。

未提交的外部预热不进入侧栏：即使 Harness 已返回 Native Session 身份，Host 也只在当前 Session 状态中保留它，映射仍为 `creating`，不发出 `thread/started`，普通与分区会话列表均不展示。首次提交消息或执行原生命令时，Host 先提交已知身份再执行；身份仍未就绪时由后续原生状态事件提交并发布。真实原生自主 Turn 也会将预热转为正式 Thread。单纯读取、恢复或配置选择不发布草稿；清理不会留下已公布的空会话入口，重启时沿用 Mapping Store 对无原生身份的 provisional 记录的清理规则。普通非预热 Thread 的创建行为不变。

Host 在现有每 Thread 请求队列内裁决接管与释放：Turn、原生命令、配置选择、恢复等操作接管后，迟到清理返回 `discarded: false`，不关闭 Session；普通空 Thread 也不能被此接口删除。未接管且没有活动工作或历史的预热先关闭 Session、等待输出结束，再移除 Host 映射；重复清理无副作用，关闭报告失败时保留映射并阻止继续使用这个未确认关闭的预热。该标记只是当前 Host 的内存所有权，不把预分配身份持久化为原生历史。

清理是尽力发送的维护请求，传输已断开时不重放用户操作，也不因界面断开而取消已经接管的远程工作。清理成功不是其他独立会话得以创建的前提：Claude Code 的 Broker 按预留的原生写入身份隔离会话，见 [Aqua Broker](../platforms/macos/native-aqua-broker.md)。旧 Host/Broker 需要一并更新才能获得完整修复。

图标只接受识别出的 PNG、JPEG、WebP 或受限 SVG，由 Host 转成数据 URL。SVG 拒绝脚本、事件属性及部分外部资源构造。消费者必须通过图片 URL 渲染（`img` 或单色 CSS mask），不得把 SVG 或描述字段当作 HTML 注入。`iconStyle` 仅提供受限的单色、底色、圆角和内边距数据，保留原有图标外观及主题着色；不是任意 CSS 或插件 UI。

Qoder 以两个独立预装插件展示：`qoder`（海外版，保留原 ID）和 `qoder-cn`（中国版）。两者共用 `packages/adapters/qoder` 的 Adapter/Session 实现，中国版包只提供独立 Manifest 和工厂入口。插件固定选择各自的 SDK `1.0.39`：海外版 `@qoder-ai/qoder-agent-sdk`，中国版 `@qodercn-ai/qodercn-agent-sdk`；查询、认证、历史读取与 Fork 均使用同一版本对应的 SDK，不自动切换版本。海外版发现 `qodercli` / `qoder`，中国版发现 `qoderclicn` / `qodercn`，显式命令覆盖分别为 `CODEXHOST_QODER_COMMAND` / `CODEXHOST_QODERCN_COMMAND`。SDK 默认用户目录分别是 `~/.qoder` / `~/.qoder-cn`，PAT 环境变量分别是 `QODER_PERSONAL_ACCESS_TOKEN` / `QODERCN_PERSONAL_ACCESS_TOKEN`；凭据和历史由各自原生 SDK 管理。Native Ref 使用对应 Harness ID，拒绝跨版本 Resume/Fork/Rollback；Desktop 的模型、Thinking、权限和偏好按两个 Agent 分别保存。公共 Adapter 契约和路由格式不变。

Qoder 的启动认证失败或消息流意外结束会终结活动 Turn、发布 `session.faulted` 并关闭 Session，后续请求返回 `invalidState`。取消回执只表示受理；收到原生 Turn 结果前仍保持忙碌，迟到输出归属原 Turn。无人值守创建策略 `unattended-full-access` 映射为原生 `bypassPermissions`，与显式非 bypass 权限冲突时拒绝创建。

Qoder 沿用现有公共 Model Catalog 和工具投影契约，不增加专用分组、禁用状态或文件全文字段。模型目录保留 SDK 返回的模型及顺序，不因 `isEnabled` 字段过滤模型；模型选择是否成功由原生接口决定。两版 Adapter 均按工作目录缓存成功目录，不设时间有效期，显式 `refresh` 清除对应缓存，关闭 Adapter 时清空；失败结果不缓存。SDK 查询仍使用 `fetchStrategy: "cache"`，显式刷新仅绕过 Adapter 缓存，不强制原生联网更新。Write/Edit 沿用 Pi/OMP 已使用的公共工具投影兼容路径，不增加 namespace 开关或原生 patch 门槛，也不改变其他 Harness 的历史状态投影。

WorkBuddy 以独立的 `workbuddy` 预装插件接入 WorkBuddy AI 随应用分发的 CLI，普通 Session 使用该 CLI 公开的标准 `--acp` stdio 接口；精确 Fork 与修订组合公开 CLI 管理参数、原生命令和公开 rollback 扩展，跨目录时使用受来源与目标校验的临时历史桥接。它可以复用 CodeBuddy ACP 的协议实现，但拥有独立的 Harness ID 和固定安全命令目录；未显式配置时主动注入 `~/.workbuddy-ai`，避免内置 CLI 回退到 `~/.codebuddy`。插件不会自动改用 PATH 中的独立 CodeBuddy。它不连接 WorkBuddy Desktop 私有 owner runtime，不调用私有激活、admission 或 grant 接口，也不能接管 Desktop 已有任务、连接器或登录态。macOS App 已包含所需 CLI；首次 ACP 认证仍按需在 Host 外通过该内置 CLI 完成。详细能力和验证边界见 [WorkBuddy Harness 集成](../harnesses/workbuddy/workbuddy-harness-integration.md)。

## 公共查询和路由

目录请求在被请求的 Host 连接内处理，不接受客户端提供文件系统路径：

```json
{
  "id": 1,
  "method": "codexhost/harness/plugins/list",
  "params": {}
}
```

结果中的 `plugins` 包含该连接加载的所有插件描述，包括当前启用的预装 Harness：`id`、`name`、`version`、可选数据 URL `icon`、`iconStyle`、`links`、`installation`、`notice` 和 `launchCommand`。查询结果没有后端入口、文件路径、环境变量或 SDK 对象；是否可用和能力仍通过 `codexhost/harness/inspect` 获取。

Renderer 的 `listHarnessPlugins()` 使用绑定的 RequestManager 发送此固定请求并校验结果；路由代理使用当前目标 Host，显式 `clientForHost` 使用对应 Host 的客户端。旧 Host 不支持此方法时，错误会传回调用者，不伪装成空目录。目录、可用性、名称和图标按 Host 隔离；连接替换后丢弃旧响应。没有插件时仍保留官方 Codex。缺失插件的已保存 Thread/偏好保留其身份并阻止误发，不静默改为 Codex。

Composer 配置按动态插件 ID 存储，不再为每个 Harness 增加字段。新 Thread 偏好按 Host 保存，本地保留 v1 键与旧 Claude 权限偏好的读取兼容；远端不读取本地偏好，草稿切换 Host 时清除上一 Host 的内存配置。插件图片只通过图片 URL 渲染，不注入 SVG/脚本。侧栏已识别的远程 Thread 会主动加载所属 Host 的插件目录，无须先打开该 Thread；不使用本地图片覆盖远端插件资源。旧远端未提供 `iconStyle` 时仍按其原始图片显示，主题着色等显示元数据需要随远端插件更新。

新 ID 使用共享的 `encodeHarnessPluginRoute` / `decodeHarnessPluginRoute`，保留 Harness ID、Model Ref、Thinking 和 Permission Mode；结果是 `codexhost/plugin-v1@` 加规范 JSON 的小写十六进制编码，可放入 `thread/start.params.model`。这是运输编码，**不是加密，不能放入凭据**。

此前缀下的非法数据直接报错，不回落到官方 Codex。有效但未安装的插件路由同样不会交给官方 app-server。普通官方模型路由不受影响。既有七种专用编码暂时保留，后续迁移不得直接删除历史读取能力。

### 只读账号额度

可选 `HarnessAdapter.inspectAccount()` 主动返回当前原生认证的 `HarnessAccountSnapshot`，无真实额度时返回 `null`；不得把会话花费当成账号额度、返回旧认证缓存或为查询发起模型 Turn。原生 SDK、认证和额度解析属于插件；实现负责限制查询耗时及关闭检查资源。该可选扩展兼容未实现能力的插件。

`codexhost/harness/accounts/sources` 先返回当前连接中实现该能力的 Harness ID 与 Manifest 名称，Renderer 再为每个来源并行调用 `codexhost/harness/accounts/inspect`。Host 分别校验快照并隔离失败和超时，不透传原生错误或凭据；任一有效结果可立即显示，不等待其他 Harness。未实现、无数据或返回非法快照的插件不产生账号行。`codexhost/harness/accounts/list` 保留为旧 Renderer 的聚合兼容接口，新 Renderer 连接旧 Host 时也回退使用它。Renderer 在账号设置页只读展示，不注册 Codex 账号或参与多账号路由。Claude Code 的 Aqua Broker 转发 `adapter.inspectAccount`；旧 Broker 不支持时无数据。产品说明见[账号设置](../product/codex-accounts.md)。

## 运行中切换 Model / Thinking

支持配置选择的 Adapter 不因已有活动 Turn 而拒绝 `model.select` / `thinking.select`；通过原生配置接口执行，或更新供下一次原生调用使用的配置。生效时机由 Harness 决定，Host 不承诺当前 Turn 中途换模型，也不统一排队到 Turn 结束。原生拒绝仍作为失败返回，配置成功后发布已确认的 `session.state.changed`。

仅放开运行中配置选择：初始化/Turn 接收过程、并行配置写入和历史读取的一致性保护仍保留；第二个 Turn、历史变更、关闭/故障和 Permission Mode 的既有约束不变。Antigravity 按启动该 CLI 进程时的 Model 计算当前 Turn 用量，后续配置选择不会重标已运行请求。

## 运行中调整方向

外部 Thread 的「调整方向」使用公共 `turn.cancel` → 等待旧轮终态 → `turn.start`，不要求插件新增 steer 命令。Host 负责替换协调，Renderer 复用正常发送展示；官方 Codex Thread 保留原生 steer。执行、版本化绑定、输入限制和验证边界见[外部 Thread 调整方向](external-thread-steering.md)。

## 构建、发行与远程路径

`npm run build:typescript` 在 TypeScript 编译后执行 `npm run build:plugins`，按发行清单生成 Host 的相邻插件目录。`npm start` 沿用这个构建路径；`--no-build` 需要之前已生成插件产物。根目录普通发行构建包含预装插件，核心 Host 自身则不依赖这些 Adapter 包。

[`build-plugin.mjs`](../../packages/harness-adapter/scripts/build-plugin.mjs) 将每个插件入口及其经审查的 JavaScript 运行依赖分别打成 `plugin.mjs`，并复制 Manifest 和图标；不打包原生 Harness 可执行文件或登录态。[`harness-plugins.mjs`](../../scripts/release/harness-plugins.mjs) 负责发行集合编排、文件清单与启用配置。构建输出是可重建的产物目录，不应指向用户插件目录。

Host release Bundle 不再包含 Adapter 或 Harness SDK；Bundle 审计拒绝它们重新泄漏进核心。npm 和 Installer 的文件白名单包含每个插件的入口、Manifest、图标及根目录启用文件，现有第三方许可声明继续随发行版交付。

DeepSeek 插件通过自身的 HTTP/WebSocket 实现连接受支持的本机 DSH，不打包 DSH CLI。Legacy 专用的 `@deepseek-ai/dsh-apiproxy`、`@deepseek-ai/dsh-session` SDK 及其打包项已移除；只有 V0/V3 `settings/describe` 权限解析使用的 `schemastery` 也随这两个 profile 移除，插件运行依赖只剩 `diff`、`ws` 和 `zod`。V4 profile 和 Assistant 流解析属于插件，不进入 Host 或 Renderer；V4 的 `developer/message`、surface 引用和 Fork closer 也不会泄漏到公共契约。

普通 Host、Remote Control 和 SSH listener 的每个连接都从该连接实际使用的 Runtime 旁查找插件。SSH 安装继续引用远端包中的 Host Runtime，不需要回退本机目录。手动复制 Runtime 时必须同时携带相邻 `plugins/`；仅复制 `host-runtime.mjs` 将得到没有预装 Harness 的核心，而不是隐式加载本机源码。macOS Aqua Broker 也经同一个 Loader 只创建其需要的插件，并使用直接模式和冷实例，避免递归创建 Broker 客户端。

## 已执行验证与剩余验收

本阶段有针对以下行为的自动化测试：

- 新 ID 的加载、描述克隆、显式启用、重复 ID、保留 ID、版本不兼容、坏模块隔离。
- Manifest/入口/图标 symlink 逃逸、大小限制、主动 SVG 拒绝、工厂身份不符、超时返回清理与幂等关闭。
- Host 中未知插件的目录查询、检查、Thread 创建、持久化身份、关闭；未安装和非法路由不泄漏到官方流；官方请求继续转发。
- 共享路由的配置往返、规范性、长度及输入验证；Renderer 目录结果校验和不同客户端隔离；共享契约 browser bundle。
- 预装插件的真实工厂加载、独立实例、显式 CLI 参数、后台预取和 macOS Broker 无直接回退；通用会话导入入口在动态加载后绑定 Adapter，旧 DSH RPC 复用同一事务。
- 分离构建并搬移到仓库外的 Host/插件产物：加载完整预装集合、额外用户插件，以及移除所有插件后官方请求继续转发。
- 恢复、Pi/DeepSeek 导入、委派、协议路由和 Renderer 的定向回归。

这些是合成测试、构建和分离 Bundle 冒烟检查，不等同于真实 Codex Desktop、所有原生 Harness、macOS Broker、SSH 远端或完整安装/升级验收。后续仍须按架构方案的能力基线和发布 Gate 完成迁移与验证。
