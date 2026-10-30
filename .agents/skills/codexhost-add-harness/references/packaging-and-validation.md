# 加载、发行与验证

对应能力总表：A1–A2、D1–D5。规则以 `docs/architecture/harness-plugin-runtime.md` 为准；数值限制以共享 schema 为准，本页不维护副本。

## 运行时交付：最小文件与依赖

```text
<可信插件根目录>/
├─ enabled.json                  该根目录的执行许可，不是插件 Manifest
└─ <插件目录>/
   ├─ manifest.json              必需
   ├─ plugin.mjs                 必需的可执行 ESM 入口（也可以是 dist/plugin.js）
   ├─ assets/...                 Manifest 引用时需要
   └─ ...                        入口依赖的模块、包和运行资源
```

一个 Bundle 可以同时包含工厂、Adapter 和 Session。入口用 `.js` 时，按 Node ESM 规则声明 package type。Host 不直接加载 TypeScript，也不自动安装依赖；原生 Harness 的可执行文件和认证也不由 Loader 提供。

## Manifest

按 `packages/shared-contracts/src/harness-plugins.ts` 校验：

- 必填：`manifestVersion: 1`、`id`、`name`、`version`、`adapterApiVersion`（与当前 `HARNESS_PLUGIN_API_VERSION` 一致）、`entry`。
- `id` 遵守专用的 schema（小写，可用 `.`、`_`、`-` 分隔），`codex` 是保留 ID。Manifest、Adapter、Session 和 Native Ref 中的身份必须一致。
- 展示与安装相关的字段见[连接页](spec-connections.md#manifest-展示字段)。
- Manifest 最大 32 KiB，图标最大 128 KiB。
- Manifest 只描述身份、兼容性、展示和安装指引；能力来自 inspect、Session 和可选接口。

## 工厂与共享资源

接口见 `packages/harness-adapter/src/plugin.ts`：

```ts
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { SampleAdapter } from "./adapter.js";
import { createSampleInstallation } from "./installation.js";

export function createHarnessAdapter(context: HarnessPluginContext) {
  const environment = { ...context.environment };
  return Object.assign(new SampleAdapter({ environment }), {
    installation: createSampleInstallation(environment),
    install: createHarnessInstaller(environment, {
      posix: "https://example.com/install.sh",
      windows: "https://example.com/install.ps1",
    }),
  });
}
```

`SampleAdapter` 是插件自己实现的类，不是公共库提供的基类。

- Context 提供：`environment`（加载时冻结的快照，不负责过滤凭据）、`platform`、`managedRemoteHost`、可选的 `launchCommand`、`brokerDescriptorPath`、`openLocalUrl`、`openLocalPage`（受管远程 Host 上没有后两项）。
- 每个 Host 连接都有自己的 Adapter 实例。Node 会缓存模块，模块级的可变状态不会自动按连接隔离。
- 工厂要及时返回，工厂和 Adapter 创建的所有资源最终都由 `adapter.close()` 管理；工厂抛错之前，要清理已经部分初始化的资源。
- 工厂模块还可以导出可选的 `warmup(adapter)` 做尽力预取；一般不需要，不要加空实现。
- Loader 会校验可选能力的方法形状；但启用插件就等于信任它的进程内代码，Loader 不是安全沙箱。

### 复用与变体

- 可以依赖公共包：`@codexhost/harness-adapter`、`@codexhost/shared-contracts`、`@codexhost/harness-discovery`。
- 可以依赖**另一个 Adapter 包的公开导出**，前提是该包的 `index.ts` 明确导出了对应 API。例如 qoder-cn 只包含 Manifest 和工厂，调用 `@codexhost/adapter-qoder` 的 `createHarnessAdapter(context, "cn")`；WorkBuddy 复用 CodeBuddy 的 ACP 实现。被复用的包要把变体当作参数，而不是在内部硬编码判断 ID。
- 不能导入另一个 Adapter 的内部文件，也不能导入 Host、Renderer 的私有实现。

### 两种发现，不要混淆

| 发现的对象 | 由谁负责 | 插件需要做什么 |
|---|---|---|
| 插件的 ESM 入口 | Host Loader | 提供 Manifest 和入口，由根目录的 `enabled.json` 显式启用 |
| 本机的原生 Harness 程序 | 插件调用公共的 `harness-discovery` | 声明 `HarnessDiscoverySpec`，不复制搜索算法（见[连接页](spec-connections.md#可执行文件发现)） |

## 安装与信任

读 `packages/host-runtime/src/installed-harness-plugins.ts` 和 `harness-plugin-loader.ts`：

- Host 从实际 Runtime 旁边的 `plugins/` 和用户根目录加载插件。用户根目录由 `CODEXHOST_PLUGIN_DIRECTORY`、`CODEXHOST_DATA_DIR` 或默认数据目录决定。
- 每个根目录有自己的 `enabled.json`，格式如 `{"version":1,"enabled":["sample-agent"]}`；未启用的插件不执行，也不出现在目录中。
- 不同根目录中出现同一个 ID 时，一律拒绝。
- 修改后需要重启 Host；不支持热替换或热卸载。
- 每个插件的导入和工厂有 10 秒超时；单个插件失败只会让它自己变为 unavailable。

开发验收使用临时的隔离根目录，不覆盖用户真实的插件或启用配置。

## 公共契约扩展

只有在公共契约确实无法表达某项原生能力时，才修改公共代码：

1. 在 `CAPABILITIES.md` 的「受限与已知缺口」中记录缺口：原生语义是什么，现有哪个接口为什么表达不了。
2. 设计**与 Harness 无关**的可选扩展：可选字段或方法，缺省时保持旧行为，旧插件仍然能加载。
3. 同时更新类型、schema（`shared-contracts`）、Host 投影、使用方（Renderer 或 Console）、测试和 `harness-plugin-runtime.md`；更新本 Skill 的[能力总表](capability-inventory.md)和[接口索引](interface-index.md)。
4. 浏览器共享的契约保持 Node-free，Renderer 不导入原生 SDK。

禁止：按 Harness ID 增加分支、增加新的专用路由 codec、在 Manifest 中虚构 capability。

## 插件外文件清单

| 场景 | 需要修改的文件 |
|---|---|
| 用户独立插件 | 无 |
| 仓库内源码包 | `packages/adapters/<id>/`（package.json、tsconfig.json、manifest.json、`CAPABILITIES.md`、assets、src、test）；根 `tsconfig.json` 的 references；`package-lock.json` |
| 预装发行 | 上一行，加上 `scripts/release/harness-plugins.json` 的 `plugins`；新增运行依赖时更新 `runtimePackages`；插件需要额外的运行资源时，核实 `packages/harness-adapter/scripts/build-plugin.mjs`、`scripts/release/prepare-payload.mjs`、`prepare-npm.mjs` 及对应 release 测试 |
| 加载测试 | `packages/host-runtime/test/installed-harness-plugins.test.ts`（预装集合）；改动了加载机制时，还要改 `harness-plugin-loader.test.ts` |
| 文档 | `docs/harnesses/<id>/<id>-harness-integration.md`、`docs/index.md`、`docs/harnesses/capability-boundaries.md`、README 能力表（以及 `docs/project/README.*.md`）；按需更新 `harness-plugin-runtime.md` 的安装/更新表、`docs/product/usage-metering.md` 和 `usage-statistics.md` 的「已接入」列表 |
| 可选 | `agent-group-preference.ts` 的显示顺序、`tools/renderer-binding` 和 `tools/codex-desktop-contract-audit` 的名单、`tests/e2e/renderer-<id>.spec.ts` |

Host 包及其 tsconfig 不增加具体 Adapter 的依赖；`tools/check-boundaries.mjs` 和核心 Bundle 审计会拒绝 Adapter 或 SDK 泄漏进核心。

`npm run build:typescript` 会编译并生成预装插件；源码启动用 `npm start`。

## 远程与专用运行环境

- 普通 Host、SSH、Remote Control 使用各自实际 Runtime 旁边的插件；搬移 Runtime 时要一起带上 `plugins/`。
- 工厂的 environment 和每次 Session open 的 environment，都要到达真正的执行进程。
- macOS Aqua Broker 通过同一个 Loader 创建冷实例。部分可选能力（版本更新、Credits 等）在 Broker 路径下不一定会转发，需要单独核实。不要为新 Harness 默认复制 Broker。

## 验证分层

| 层次 | 必须证明 | 位置或参考 |
|---|---|---|
| Adapter 公共行为 | 能力总表中所有「支持」行的行为，以及「不支持」行的拒绝 | 插件自己的 test；`packages/harness-adapter/src/testing.ts` 的 Fake 只作为语义参考 |
| 原生边界 | 启动参数与环境、SDK/RPC 解析、事件关联、超时与退出、原生历史、平台差异 | 插件的 Transport/投影测试；用**模拟原生进程的 fixture** 驱动（例如 `codebuddy/test/fixtures/acp.mjs`、`cursor-cli/test/fixtures/acp.mjs`），回放真实的原生历史样本（例如 `deepseek-harness/test/fixtures/*.v4.jsonl`） |
| 插件加载 | 真实的 ESM 工厂、身份、资源、依赖、独立实例、close；能区分「未安装 CLI」和「插件损坏」 | `packages/host-runtime/test/installed-harness-plugins.test.ts` |
| Host 集成 | 目录查询、inspect、共享路由创建、Turn、持久化与恢复；错误不落到官方路径 | `packages/host-runtime/test/app-server-host*.test.ts` |
| 预装发行 | Bundle 在仓库外能加载，不借用 workspace 或 node_modules；依赖和许可齐全 | `tests/release/host-bundle.test.mjs`、payload/npm 测试 |
| Desktop / 委派 | 对应范围的可见行为和目标环境 | [Desktop](spec-desktop.md)、[委派](spec-delegation.md) |

按改动范围执行：

- 改动或新增的代码：类型检查、ESLint、Prettier（只针对修改过的文件）、边界检查、`git diff --check`。实际命令以根 `package.json` 的 scripts 为准。
- 指定具体文件运行测试：`vitest run --config tests/vitest.config.js <测试文件...>`。
- 真实原生验收要记录：Harness 版本、平台、认证条件、Model、权限、运行环境（local/SSH/Remote Control），以及成功、失败、取消、恢复的结果。

不默认运行全仓库测试。合成测试、构建和真实 Harness 验收要分开报告。
