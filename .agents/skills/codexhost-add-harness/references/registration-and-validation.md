# 注册、发布与验证

Adapter 代码完成不代表 Harness 已完成产品接入。当前仓库使用显式注册和静态 release bundle；新增 Harness 时应从源码搜索现有 Harness ID，确认所有同类接线位置。

## Adapter 包

在 `packages/adapters/<harness>/` 创建独立包，通常包含：

- `src/index.ts`：只导出 Host Runtime 需要的 Adapter、选项和必要类型；
- Adapter 主模块；
- 原生 Transport 或 SDK 封装；
- History、Model、Usage、Interaction 等有独立职责的投影模块；
- 聚焦测试；
- `package.json` 和 `tsconfig.json`。

包应依赖：

- `@codexhost/harness-adapter`
- `@codexhost/shared-contracts`
- CLI 发现需要时的 `@codexhost/harness-discovery`
- 经过审查的原生 SDK 或协议依赖

原生协议细节不得泄漏到 `protocol-core`、`shared-contracts`、`renderer-extension` 或其他 Harness Adapter。

## Harness discovery

CLI Harness 应优先使用 `packages/harness-discovery/src/`：

- 定义 `HarnessDiscoverySpec`；
- 提供默认命令和显式命令环境变量；
- 按平台声明常见安装根目录；
- 需要 Node shebang 时使用 `withNodeRuntimeOnPath()`；
- Windows `.cmd` / `.bat` 使用共享 invocation 逻辑；
- 用户显式配置命令后，不得静默回退到另一套安装。

`inspect()` 应报告发现和启动阶段，而不是只在第一次 Turn 时暴露未安装错误。

## Protocol routing

检查 `packages/protocol-core/src/model-routing.ts`：

- 增加稳定 `ExternalHarnessId`；
- 增加基础 Transport Model ID；
- 更新 Harness ↔ Transport Model 映射；
- 如果支持在 Transport Model 中编码 Model、Thinking 或 Permission Mode，则实现并测试严格的 encode/decode；
- 更新 create route 的识别和验证；
- 不允许新编码与现有 Harness 前缀冲突。

使用 lowercase `codexhost` 品牌和稳定、transport-safe 的 ID。

## Runtime composition

检查 `packages/host-runtime/src/adapter-composition.ts`：

- 导入 Adapter；
- 定义必要的 codexhost 配置环境变量；
- 在 `createExternalHarnessAdapters()` 中构造并注册；
- 将 Runtime environment 传给 Adapter；
- 只有真实启动需要时才添加预取或特殊初始化。

通用 Runtime、External Thread 和 Delegation 逻辑应通过 Adapter Map 自动支持新 Harness。出现新 Harness 专用分支时，先判断是否缺少公共接口，避免绕过 seam。

继续搜索 Harness 配置环境是否跨运行模式传播：

- `packages/host-runtime/src/run-host-runtime.ts` 的普通、Remote Control 和 Unix/WebSocket listener 组合；
- `packages/host-runtime/src/app-server-host.ts` 的 `officialEnvironment()` 内部变量过滤；
- `packages/host-runtime/src/remote-host-install.ts`、`remote-host-lifecycle.ts` 和 `remote-host-cli.ts` 的 SSH Remote Host 安装配置；
- `crates/launcher/src/main.rs` 和 npm launcher 的显式启动选项与环境转发。

这些位置只在新 Harness 需要用户显式 command、endpoint、默认 Agent、远程安装配置或 Launcher-owned 资源时修改。自动发现即可满足时不要增加无意义的 Launcher 参数；需要显式配置时也不能只接本地模式而遗漏 Remote Control 或 SSH Host。

## Host Runtime 包和导出

检查：

- `packages/host-runtime/package.json` 的 Workspace dependency；
- `packages/host-runtime/src/index.ts` 的 package metadata 和公共导出；
- 相关 package metadata 测试；
- 根 `tsconfig.json` 和新包 `tsconfig.json` 的 project references；
- 根 Workspace、lockfile 和构建是否覆盖新包。

只导出调用方真正需要的内容，不把 Adapter 内部 Transport 作为 Host Runtime 公共接口。

## Release bundle

检查 `packages/host-runtime/scripts/build-release.mjs`：

- 新 Adapter 源码必须进入 release bundle；
- 新原生运行时依赖必须加入允许列表；
- required input 审计应包含新 Adapter；
- 第三方依赖的 license metadata、license 文件、`THIRD_PARTY_NOTICES.txt` 和 package/payload 文件白名单必须更新；
- 不应意外打包测试、工具、source map 或不允许依赖。

同时搜索：

- `scripts/release/prepare-payload.mjs`
- `scripts/release/prepare-npm.mjs`
- `scripts/release/prepare-npm-meta.mjs` 中会因产品范围变化而过期的 description、keywords 和 README 文案
- npm package 和 release 测试

只有当前脚本确实按 Harness 特判时才修改；不要机械增加无意义分支。

## Renderer 产品接入

正式 Harness 必须读取 [renderer-product-integration.md](renderer-product-integration.md)。当前 Agent Picker、Renderer Transport Model 写入、Thread ownership 恢复、Label/Icon/安装 URL、Settings Connections、侧边栏图标、Desktop Control 启用列表和部分 Usage/Credits 策略都是显式接线，不会从 Adapter Map 自动发现。

如果工作范围明确只是后端原型，应把 Renderer 产品接入列为推迟项，不得把“Adapter 可运行”报告为“Desktop 已完成接入”。

## Shared contracts 和 Renderer 边界

仅当多个 Harness 或浏览器端确实需要新概念时，才修改 `shared-contracts`：

- `shared-contracts` 不得依赖 Node.js-only 能力；
- `renderer-extension` 不得导入 Node built-ins、Electron private API 或 Harness SDK；
- Harness 私有协议不得进入公共 schema；
- 新公共能力需要 schema、类型、Host 投影和 Renderer 使用方一致更新。

一个新 Harness 的原生字段通常应在 Adapter 内转换为已有公共类型，而不是扩展公共协议。

## 测试分层

### 公共契约测试

通过 `HarnessAdapter` / `HarnessSession` 测试：

- inspect；
- create/resume；
- Turn 成功、失败和取消；
- 并发和关闭；
- Snapshot；
- 配置和能力一致性；
- Interaction；
- Usage；
- 支持的 History 操作。

可使用 `packages/harness-adapter/src/testing.ts` 的 Fake 和 `packages/harness-adapter/test/text-session.test.ts` 作为语义基线。

### Transport 测试

测试原生层：

- 进程命令、参数和环境；
- RPC framing、SDK 回调或协议解析；
- Native event 到内部事件转换；
- 超时、异常退出和错误诊断；
- Windows/Unix 差异；
- 历史或 Transcript 解析边界。

### Host 集成测试

根据能力在 `packages/host-runtime/test/` 增加聚焦覆盖：

- Adapter composition 注册；
- Approval 展示名；
- Account Credits（如支持）；
- `thread/start` 和 `turn/start` 路由；
- `thread/read` / resume；
- Model、Thinking、Permission Mode；
- fork / rollback；
- Usage、Commands、Subagent；
- `codexhost harness inspect` 的通用 Catalog/capabilities 路由；
- 跨 Harness delegation 的默认配置省略、显式 Model/Thinking、首次 Turn、后续 send、cancel、只读 read/wait/list 和持久化 resume；
- 递归委派所需 Runtime 环境传播。

正式产品接入还应按 [renderer-product-integration.md](renderer-product-integration.md) 覆盖 `renderer-extension`、`desktop-control`、Renderer probe/audit 和 production Renderer release test。若新 Harness 对外发布，还应检查用户 README、能力矩阵、安装说明和 npm metadata 是否仍准确。

不要只测试 Adapter 内部私有函数而跳过公共 seam。

## 文档和能力清单

实现前列出：

```text
支持：create、resume、Turn、Model、Usage、Delegation
不支持：fork、rollback、Subagent
受限：Permission Mode 只能在 create 时选择
```

实现后重新核对：

- `inspect().capabilities`
- Session `capabilities`
- 实际 `open()` 和 `execute()`
- 测试
- 用户可见行为

五者必须一致。原生系统不支持的能力应明确报告，不能通过空实现或伪造状态表现为成功。只有公共契约明确允许、原生执行基线已经满足且有测试证明的 deliberate no-op 才能不执行原生配置，例如 Pi 接受委派执行策略但不传不存在的权限参数。

## 推荐验证命令

根据改动范围运行聚焦检查，至少包括：

```bash
npm run typecheck
npm run lint
npm run format:check
```

运行：

- 新 Adapter 的测试；
- `packages/harness-adapter` 公共契约测试；
- 受影响的 `protocol-core` 和 `host-runtime` 测试；
- 正式 UI 接入时受影响的 `renderer-extension`、`desktop-control`、Renderer probe/audit 和 production Renderer 测试；
- 修改 release composition 时的 Host/Renderer/Desktop Controller bundle、payload、npm packaging 和 license/notice 测试。

不要默认运行整个仓库测试；高风险、跨包或用户明确要求时再扩大范围。不得声称未执行的检查通过。

## 完成门槛

新增 Harness 只有同时满足以下条件才算完成：

1. Adapter 通过公共 seam 工作。
2. 能力声明和原生行为一致。
3. Thread 可以正确创建、运行、读取，并在支持时恢复和编辑历史。
4. 所有适用 Host、Renderer 和 Desktop Control 注册点已完成。
5. Release 构建包含 Adapter、受审查依赖及其第三方声明。
6. 聚焦测试覆盖公共契约、原生边界和适用的产品 UI。
7. 跨 Harness 环境、inspection、显式/默认配置、后续消息、取消、持久化恢复和递归委派要求已验证。
8. 完整 Agent 协调所需的普通可写 Thread 语义已验证；不支持或推迟的能力已明确记录。
