# Harness 插件运行时：动态加载与预装发行

> 状态：七个既有 Harness 和用户目录插件已统一使用动态加载器；**完整插件化尚未完成**。本文描述当前代码，不替代[架构与迁移方案](harness-plugin-architecture.md)。

## 当前范围

当前源码启动路径可以加载原先不认识的外部 Harness ID，通过 `codexhost/harness/plugins/list` 返回描述，并通过公共 Harness 检查接口和 `thread/start` 调用该插件。

七个既有 Adapter 通过同样的 `manifest.json` 和 `createHarnessAdapter` 工厂加载；`adapter-composition.ts` 已删除，Host 源码、包依赖和 TypeScript references 不再直接引用具体 Adapter 包。预装集合仅由发行清单 [`scripts/release/harness-plugins.json`](../scripts/release/harness-plugins.json) 决定。原生构造参数、预取和 Claude Code 的直接/Broker 选择仍由相应插件负责。

本地会话导入已使用公共 `sessionImport` 契约、Host 映射事务与动态设置页；Pi 和 DSH Modern 是两个实际实现。完整原生引用只在 Adapter 与 Host 间流转，详见[会话导入](harness-session-import.md)。这不代表普通 Agent Picker 已完成动态接入。

尚未实现的目标包括：

- Renderer Picker、图标、Composer 状态、偏好及 Sidebar 全部改由目标 Host 目录驱动。目前只提供经过校验、按连接发送的 Renderer 目录查询客户端，**新插件不会自动出现在现有 Picker 中**。
- 删除 Renderer 等公共层的剩余 Harness 静态名单、旧路由和按名称区分的恢复策略。Host 的 Adapter 静态 import 和注册名单已移除。
- 正式 Credits 接口、远程/Broker Session Import 接入、插件拥有的旧数据迁移。
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
- 链接只接受不带用户凭据的 HTTPS 地址。
- 能力继续由 `HarnessAdapter.inspect()`、Session 能力和公共可选接口提供，不在 Manifest 复制第二份运行时能力真相。
- 命令目录由可选的静态 `HarnessAdapter.commandCatalog` 声明，通过 `codexhost/harness/commands/inspect` 查询；读取目录不检查原生运行时、不连接原生服务、不创建或恢复 Session。未声明时返回空目录，不通过启动会话回退发现。执行仍走 `session.commands`。

入口导出 [`HarnessPluginModule`](../packages/harness-adapter/src/plugin.ts) 定义的工厂，不通过模块全局副作用注册：

```ts
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { SampleAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext) {
  return new SampleAdapter({ environment: { ...context.environment } });
}
```

这里的 `SampleAdapter` 代表插件自行实现的 [`HarnessAdapter`](../packages/harness-adapter/src/text-session.ts)，不是仓库提供的类。返回对象的 `harnessId` 必须与 Manifest 一致；工厂可异步返回，每个 Host 连接分别创建实例。Node.js 仍缓存模块，模块级可变状态不会自动按连接隔离。

插件可以额外导出可选的 `warmup(adapter): Promise<void>`。Host 调用它进行尽力而为的后台预取，不等待其完成后才服务请求；失败只记录稳定诊断码。当前 Claude Code 和 Antigravity 使用这个入口，其他插件无需为统一形式添加空实现。预取创建的原生资源也由 Adapter 的幂等关闭负责。专用运行时可以请求不预取的冷实例。

Context 包含环境变量快照、平台、是否为受管远程 Host，以及可选 Broker 描述符路径和本地 URL 打开服务。目录加载时环境快照被冻结；它不是凭据过滤器。受管远程 Host 不提供本地 URL 打开服务。已提供的本地服务继续经过 Native Launcher 的 loopback URL 校验，不暴露任意系统 URL 打开接口。

## 加载与关闭行为

加载器先校验所有可发现的 Manifest，再导入已启用模块：

- 跨目录的重复 ID 一律拒绝，不按扫描顺序或启用优先级取胜；与显式注入的测试 Adapter 冲突时也拒绝目录候选。
- 不匹配的 API 版本不执行入口，但保留 unavailable Adapter 和公开描述。
- 单插件导入、工厂或资源错误转为 unavailable，不妨碍其他正常插件加载。
- 诊断仅包含稳定错误码和公开 ID，不透传插件抛出的路径、环境值或异常正文。
- Manifest 最大 32 KiB，图标最大 128 KiB，总候选插件最多 128；加载器 API 最多接受 8 个根目录，当前启动组合使用预装和用户两个根目录。
- 最多 4 个加载 worker；异步导入和工厂共用默认 10 秒截止时间，不是每个插件串行等待 10 秒。文件系统发现、同步代码和关闭操作不保证可被超时中断。
- 超时后才返回的 Adapter 会尝试关闭；未返回实例前创建的资源仍须由插件自行负责清理。
- Host 退出时关闭已加载 Adapter；Registry 自身的 `close()` 幂等，并尝试关闭所有实例，即使某个实例同步抛错。

图标只接受识别出的 PNG、JPEG、WebP 或受限 SVG，由 Host 转成数据 URL。SVG 拒绝脚本、事件属性及部分外部资源构造。消费者必须使用 `img`，不得把 SVG 或描述字段当作 HTML 注入。

## 公共查询和路由

目录请求在被请求的 Host 连接内处理，不接受客户端提供文件系统路径：

```json
{
  "id": 1,
  "method": "codexhost/harness/plugins/list",
  "params": {}
}
```

结果中的 `plugins` 包含该连接加载的所有插件描述，包括七个预装 Harness：`id`、`name`、`version`、可选数据 URL `icon` 和 `links`。查询结果没有后端入口、文件路径、环境变量或 SDK 对象；是否可用和能力仍通过 `codexhost/harness/inspect` 获取。

Renderer 的 `listHarnessPlugins()` 使用绑定的 RequestManager 发送此固定请求并校验结果；路由代理使用当前目标 Host，显式 `clientForHost` 使用对应 Host 的客户端。旧 Host 不支持此方法时，错误会传回调用者，不伪装成空目录。

新 ID 使用共享的 `encodeHarnessPluginRoute` / `decodeHarnessPluginRoute`，保留 Harness ID、Model Ref、Thinking 和 Permission Mode；结果是 `codexhost/plugin-v1@` 加规范 JSON 的小写十六进制编码，可放入 `thread/start.params.model`。这是运输编码，**不是加密，不能放入凭据**。

此前缀下的非法数据直接报错，不回落到官方 Codex。有效但未安装的插件路由同样不会交给官方 app-server。普通官方模型路由不受影响。既有七种专用编码暂时保留，后续迁移不得直接删除历史读取能力。

## 构建、发行与远程路径

`npm run build:typescript` 在 TypeScript 编译后执行 `npm run build:plugins`，按发行清单生成 Host 的相邻插件目录。`npm start` 沿用这个构建路径；`--no-build` 需要之前已生成插件产物。根目录普通发行构建包含预装插件，核心 Host 自身则不依赖这些 Adapter 包。

[`build-plugin.mjs`](../packages/harness-adapter/scripts/build-plugin.mjs) 将每个插件入口及其经审查的 JavaScript 运行依赖分别打成 `plugin.mjs`，并复制 Manifest 和图标；不打包原生 Harness 可执行文件或登录态。[`harness-plugins.mjs`](../scripts/release/harness-plugins.mjs) 负责发行集合编排、文件清单与启用配置。构建输出是可重建的产物目录，不应指向用户插件目录。

Host release Bundle 不再包含 Adapter 或 Harness SDK；Bundle 审计拒绝它们重新泄漏进核心。npm 和 Installer 的文件白名单包含每个插件的入口、Manifest、图标及根目录启用文件，现有第三方许可声明继续随发行版交付。

普通 Host、Remote Control 和 SSH listener 的每个连接都从该连接实际使用的 Runtime 旁查找插件。SSH 安装继续引用远端包中的 Host Runtime，不需要回退本机目录。手动复制 Runtime 时必须同时携带相邻 `plugins/`；仅复制 `host-runtime.mjs` 将得到没有预装 Harness 的核心，而不是隐式加载本机源码。macOS Aqua Broker 也经同一个 Loader 只创建其需要的插件，并使用直接模式和冷实例，避免递归创建 Broker 客户端。

## 已执行验证与剩余验收

本阶段有针对以下行为的自动化测试：

- 新 ID 的加载、描述克隆、显式启用、重复 ID、保留 ID、版本不兼容、坏模块隔离。
- Manifest/入口/图标 symlink 逃逸、大小限制、主动 SVG 拒绝、工厂身份不符、超时返回清理与幂等关闭。
- Host 中未知插件的目录查询、检查、Thread 创建、持久化身份、关闭；未安装和非法路由不泄漏到官方流；官方请求继续转发。
- 共享路由的配置往返、规范性、长度及输入验证；Renderer 目录结果校验和不同客户端隔离；共享契约 browser bundle。
- 七个预装插件的真实工厂加载、独立实例、显式 CLI 参数、后台预取和 macOS Broker 无直接回退；通用会话导入入口在动态加载后绑定 Adapter，旧 DSH RPC 复用同一事务。
- 分离构建并搬移到仓库外的 Host/插件产物：加载七个预装插件、额外用户插件，以及移除所有插件后官方请求继续转发。
- 恢复、Pi/DeepSeek 导入、委派、协议路由和 Renderer 的定向回归。

这些是合成测试、构建和分离 Bundle 冒烟检查，不等同于真实 Codex Desktop、七个原生 Harness、macOS Broker、SSH 远端或完整安装/升级验收。后续仍须按架构方案的能力基线和发布 Gate 完成迁移与验证。
