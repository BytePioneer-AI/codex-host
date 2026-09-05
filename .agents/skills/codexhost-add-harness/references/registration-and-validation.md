# 加载、发行与验证

所有插件都完成“运行时交付”和“Host 验证”；只有仓库内开发、预装发行、远程配置等分支需要对应扩展。当前规则以 `docs/harness-plugin-runtime.md` 为准；数值限制读取共享 schema，不在本页维护副本。

## 运行时交付：最小文件与依赖

```text
<可信插件根目录>/
├─ enabled.json                  此根目录的执行许可，不是插件自身的 Manifest
└─ <插件目录>/
   ├─ manifest.json              必需
   ├─ plugin.mjs                 必需的可执行 ESM 入口，也可用 dist/plugin.js
   ├─ assets/...                 Manifest 引用时需要
   └─ ...                       入口依赖的模块、包和运行资源
```

一个 Bundle 可以容纳工厂、Adapter 和 Session；不要求四个独立运行文件。使用 `.js` 时按 Node ESM 规则提供 package type。Host 不直接加载 TypeScript、不自动安装依赖；原生 Harness 可执行文件和认证也不由 Loader 提供。

Manifest 按 `packages/shared-contracts/src/harness-plugins.ts` 校验：

- 提供协议版本、稳定插件 ID、名称、插件版本、Adapter API 版本和入口。
- 插件 ID 遵守专用 schema，`codex` 保留；Manifest、Adapter、Session 和 Native Ref 的身份一致。
- API 版本必须匹配当前 Host，不把它与插件自身版本混同。
- 入口和资源使用插件内相对路径；图标与链接可选。具体路径、图像格式、大小和链接限制读取 schema、`plugin-files.ts` 及运行时文档。
- Manifest 只描述身份、兼容与展示，能力来自 inspect、Session 和可选接口。

## 工厂与共享资源

读取 `packages/harness-adapter/src/plugin.ts`：

```ts
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { SampleAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext) {
  return new SampleAdapter({ environment: { ...context.environment } });
}
```

`SampleAdapter` 是插件自己实现的类，不是公共库提供的基类。示例仅展示工厂调用，不代替 Adapter 实现。

- 从 Context 接收基础 environment、platform、managedRemoteHost 和可选服务；命令、endpoint、SDK 构造和原生版本选择由插件处理。
- 每个 Host 连接有自己的 Adapter 实例；Node 缓存模块，模块级可变 Session 状态不会自动隔离。
- 工厂负责及时返回实例，所有创建资源最终由 Adapter close 管理。工厂抛错前清理部分初始化资源；不能只依赖 Loader 回收尚未返回的对象。
- 可选 `warmup(adapter)` 用于不阻塞服务的尽力预取，失败由 Loader 隔离；不要加空实现，不在预取中创建用户 Turn。
- 复用公共工具及经审查依赖，不导入 Host/Renderer 私有实现或其他 Adapter 的内部模块。

### 两种发现，不要混淆

| 发现对象 | 拥有者 | 插件需要做什么 |
|---|---|---|
| 插件 ESM 入口 | Host Loader | 提供 Manifest 和入口，由根目录显式启用 |
| 本机原生 Harness 程序 | 插件调用公共 `harness-discovery` | 声明 `HarnessDiscoverySpec`，不复制搜索算法 |

CLI 插件需要时读取 `packages/harness-discovery/src/index.ts`、`resolve.ts`、`invocation.ts`、`node-runtime.ts`。命令名、专用环境变量、安装目录及特殊入口策略归插件；PATH、平台扩展、版本管理器搜索、Windows shim 调用和 Node PATH 补充机制归公共包。用户显式配置一套安装后，不静默回退另一套。

## 安装与信任

读取 `packages/host-runtime/src/installed-harness-plugins.ts` 和 `harness-plugin-loader.ts`。

- Host 从实际 Runtime 相邻的 `plugins/` 和用户根目录加载；用户根目录由 `CODEXHOST_PLUGIN_DIRECTORY`、`CODEXHOST_DATA_DIR` 或默认数据目录决定。
- 每个根目录自己持有 `enabled.json`，形如 `{"version":1,"enabled":["sample-agent"]}`；未启用不执行、不列入目录。
- 用户根目录不是预装覆盖层；跨根目录同 ID 候选冲突会被拒绝。用户的 enabled 文件不控制预装根目录。
- 当前需要重启 Host；不扫描任意项目目录，不支持热替换或热卸载。
- **启用是信任进程内代码，不是沙箱授权**：插件拥有 Host 进程权限，环境可能包含凭据；异步超时不能中断同步阻塞或隔离进程级退出。

开发验收使用临时隔离根目录，不覆写真实用户插件或启用配置。需要实际安装、启用或更新用户文件时按用户授权范围执行，保留已有插件；构建器输出只指向可重建的产物目录。

## 仓库内开发与预装发行

### 仓库内源码包

通常放在 `packages/adapters/<harness>/`，有 package/tsconfig、Manifest、工厂、实现和测试；`index.ts` 只导出真实调用方需要的 API。内部文件按职责组织，不照抄参考 Adapter 的文件数量。

- 依赖公共 `harness-adapter`、`shared-contracts`，按需依赖 discovery 和原生 SDK。
- 核对根 Workspace、project references、测试编译范围和 lockfile；先看当前通配规则，已有覆盖的不机械修改。
- Host 包及其 tsconfig 不增加具体 Adapter 依赖。公共层源码和核心 Bundle 审计继续禁止静态引入 Adapter/SDK。
- 独立用户插件可以在仓库外开发，不要求加入本仓库 Workspace。公共包目前的获取与构建方式按实际环境解决，不假设存在完整独立发布/升级服务。

### 随 codexhost 预装时

读取：

- `scripts/release/harness-plugins.json`：预装包集合与审查过的运行依赖。
- `scripts/release/harness-plugins.mjs`：集合构建、路径清单、启用文件生成。
- `packages/harness-adapter/scripts/build-plugin.mjs`：单插件 ESM Bundle 和资源复制。
- `scripts/release/prepare-payload.mjs`、`prepare-npm.mjs`：发行装配。
- `packages/host-runtime/scripts/build-release.mjs`、`tools/check-boundaries.mjs`：核心依赖与源码边界审计。

完成独立插件打包、许可/第三方声明、payload/npm 白名单和搬移验证。当前构建器自动复制 Manifest 和图标；插件若需要额外运行资源，必须核实并实现其打包和文件清单，不能只在仓库内运行成功。

用户独立安装不修改预装清单。新增预装条目也不意味着需要给 prepare 脚本增加 Harness 名称分支；优先使用现有清单驱动路径。

`npm run build:typescript` 会编译并生成预装插件；其他构建入口先查根 `package.json`。源码启动用 `npm start`；无构建启动要求已有插件产物。

## 远程与专用运行环境：按范围验证

- 普通 Host、SSH、Remote Control 使用其实际 Runtime 的相邻插件，不能借用本机源码或 cwd；搬移 Runtime 时一并携带插件。
- 工厂 environment 与每次 Session-open 的 environment 都要到达真正的执行进程；共享服务不能仅保存首个 Thread 的私有环境。
- 新 command/endpoint 等参数若需要 Launcher 或 SSH 配置支持，再读取 `run-host-runtime.ts`、`officialEnvironment()` 所在的 `app-server-host.ts`、`remote-host-install.ts`、`remote-host-lifecycle.ts`、`remote-host-cli.ts` 及实际 Launcher；自动发现够用时不增加参数。
- Claude 的直接/Broker 选择属于其插件，专用 Broker owner 仍有 Claude 协议。不要为新 Harness 默认复制 macOS Broker；确有类似需求时单独验证运行身份和资源所有权。

本页未列出绝对前缀的 Host 源文件均位于 `packages/host-runtime/src/`。

## 验证分层

| 层次 | 必须证明 | 建议位置或参考 |
|---|---|---|
| Adapter 公共行为 | 检查、创建、后续 Turn、取消、快照、配置、交互、错误、并发和 close；按能力补 resume/派生 | 插件自己的 test；公共 Fake/契约测试仅作语义参考 |
| 原生边界 | 启动参数/环境、SDK/RPC 解析、事件关联、超时/退出、原生历史和平台差异 | 插件 Transport/投影测试 |
| 插件加载 | 实际 ESM 工厂、身份、资源、依赖、独立实例、close；未安装 CLI 与坏插件应被正确区分 | `packages/host-runtime/test/harness-plugin-loader.test.ts`、`installed-harness-plugins.test.ts` |
| Host 集成 | 目录查询、inspect、共享路由创建、Turn、持久化/恢复及支持能力；错误不落官方路径 | `packages/host-runtime/test/app-server-host.test.ts`、受影响的 Runtime 测试 |
| 预装发行 | Bundle 在仓库外加载，不借用 workspace/node_modules；依赖及许可齐全 | `tests/release/host-bundle.test.mjs`、payload/npm 测试 |
| Desktop/委派 | 对应范围的可见行为和目标环境 | [Renderer 清单](renderer-product-integration.md)、[委派清单](cross-harness-delegation.md) |

新插件通过真实 Loader + Host 测试，不能只直接构造 Adapter。已有 Loader 的重复 ID、资源逃逸、超时等通用测试可复用；没有修改加载机制时不为每个 Harness 复制整套基础设施测试。

所有新 ID 的路由使用 `packages/shared-contracts/src/harness-route.ts`。新增集成验证其与 `packages/protocol-core/src/model-routing.ts` 相容；非法或未安装插件路由不落到官方 Codex，官方路径保持正常。不扩展旧七种专用 codec。

按改动范围执行：

- 新增/修改代码的类型、ESLint、Prettier、边界和 diff 检查；从根 package scripts 获取实际命令，格式化只作用于修改文件。
- 选择具体文件运行 `vitest run --config tests/vitest.config.js <测试文件...>`；先满足所需编译产物。
- 预装时增加构建、Bundle、payload/npm 和第三方声明检查；UI 接入时增加 Renderer build 与对应测试。
- 真实原生验收记录 Harness 版本、平台、认证条件、Model、权限、local/SSH/Remote Control、成功/失败/取消/恢复结果。

不默认运行全仓库测试；合成测试、构建与真实 Harness 验收分开报告。纯文档修改只需相应文档检查，不能声称未执行的运行测试通过。
