---
name: codexhost-add-harness
description: 为 codexhost 新增 Harness 插件，或规划、审查、补全现有 Harness Adapter。按当前公共契约实现原生能力，区分插件后端、预装发行和 Desktop 产品接入；不用于单纯添加 Model、Provider 或账号。
---

# 新增 codexhost Harness 插件

目标：交付一个通过公共契约工作的独立插件，而不是在 Host 中增加一套 Harness 专用流程。插件是交付与加载单元，`HarnessAdapter` / `HarnessSession` 是运行时接口；不要求继承基类，也不要求使用 ACP。

本文代码路径以仓库根目录为基准，`references/` 链接相对于本 Skill。接口签名、字段限制和当前行为以源码为准；参考文档是实现与验收清单，不是第二份接口定义。

## 当前架构边界

```text
Host
├─ 发现 Manifest、读取显式启用配置、调用插件工厂
├─ 通过 HarnessAdapter / HarnessSession 执行业务
└─ 拥有 Thread 映射、持久化事务、委派和 Desktop 协议投影
             │ 公共契约
             ▼
插件
├─ Manifest：身份、版本、展示信息、入口
├─ 工厂：把 Host Context 转成原生构造参数
├─ HarnessAdapter：检查、打开 Session、关闭共享资源
└─ HarnessSession：执行、输出、状态、历史、关闭
             │ 插件内部
             ▼
原生 SDK / RPC / 服务 / CLI
```

- 七个既有 Harness 和用户插件共用动态加载器，Host 不静态依赖具体 Adapter 包。新 ID 使用共享插件路由。
- 公共工具仍可复用：例如 `harness-discovery` 实现搜索机制，插件声明命令名、环境变量和安装目录策略。
- **完整产品去专属化尚未完成**：Renderer 仍有固定 Agent 名单、配置字段和展示接线；旧路由、部分恢复策略、Credits、导入、Broker 与远程配置仍有历史特例。插件加载成功不等于自动出现在 Desktop。
- 既有特例是兼容负担，不是新 Harness 的实现模板。公共契约无法表达真实需求时，记录缺口并在当前任务范围内设计公共扩展；不得通过新 Harness 专用 Host 分支绕过契约。

## 1. 确定交付范围和能力

从用户请求判断范围；只有会影响实现边界的歧义才询问，不默认扩展为全产品改造。

| 交付范围 | 必须完成 | 不自动包含 |
|---|---|---|
| 插件后端 | 原生适配、Manifest/工厂、可运行依赖、隔离目录加载、公共行为测试 | 仓库预装、Desktop UI |
| 预装发行 | 插件后端 + Workspace 构建、预装清单、独立 Bundle、许可与发行验收 | Renderer 自动发现 |
| Desktop 产品接入 | 插件后端 + Picker、配置、恢复、展示及 UI 验收 | 必须成为预装插件 |

普通持久化 Thread 和完整委派要求可写 resume。原生系统不支持时，可以交付明确受限的后端，但不能把它称为完整产品接入；当前没有自动 ephemeral Thread 降级。

先读取以下权威入口：

- `packages/harness-adapter/src/text-session.ts`：Adapter、Session、命令、事件和可选接口。
- `packages/harness-adapter/src/plugin.ts`：工厂和 Context。
- `packages/shared-contracts/src/harness-models.ts`：Catalog、能力和检查结果。
- `packages/shared-contracts/src/harness-plugins.ts`：Manifest、描述与启用配置。
- `docs/harness-plugin-runtime.md`：已实现边界、安装、信任和发行规则。

核对目标 Harness 的当前原生接口、版本、认证和运行方式。实际可行时优先原生 SDK、RPC 或服务接口；只有原生接口不可用或确有理由时使用 ACP，并记录能力差异。不要以 CLI 名称相似推断协议兼容。

使用 [实现导航](references/current-harness-implementations.md) 按传输和能力选参考，不整包复制。输出简短计划：

```text
交付：插件后端 / 预装发行 / Desktop（可组合）
原生接口与版本：……
支持：create、resume、Turn、取消、历史、工具、Question……
不支持或受限：Fork、权限仅创建时设置……
待验证：……（不能当作不支持，也不能声明已实现）
参考模块：……
预计修改：插件目录；其他位置逐项说明原因
```

本步完成条件：每项目标能力都有原生依据、公共映射或明确缺口，并且交付范围清楚。

## 2. 实现插件的四个职责

以下是职责清单，不是强制文件数量。Pi 的 Adapter 和 Session 就在同一个源文件中。

| 职责 | 必须提供 | 按需提供 |
|---|---|---|
| Manifest | `manifestVersion`、`id`、`name`、`version`、`adapterApiVersion`、`entry` | `icon`、文档/安装链接 |
| 工厂模块 | `createHarnessAdapter(context)`，返回身份匹配的实例 | `warmup(adapter)` |
| `HarnessAdapter` | `harnessId`、`inspect()`、`open()`、`close()` | `sessionImport`、`subagents`、`webUi` |
| `HarnessSession` | `harnessId`、`capabilities`、`initialState`、`initialUsage`、`outputs`、`readSnapshot()`、`execute()`、`close()` | `commands`、`refreshUsage()` |

`execute()` 必须处理公共命令的分派：`turn.start`、`turn.cancel`、`interaction.respond`、`model.select`、`thinking.select`、`permissionMode.select`。`open()` 必须识别 create、resume、fork、rollbackLastTurn。存在接口不代表必须支持所有原生操作：不支持的分支返回类型化 `unsupported`，不伪造成功。

所有新插件都读取并满足：

- [公共行为](references/public-adapter-contract.md)：检查、配置、并发、错误、环境和可选接口。
- [输出与交互](references/output-and-interactions.md)：Turn/Item 时序、原生输出映射、取消和故障。
- [身份与历史](references/thread-lifecycle-and-history.md)：所有插件的 identity、快照要求；按能力实现 resume/Fork/Rollback。
- [加载、发行与验证](references/registration-and-validation.md)：Manifest、工厂、依赖及 Host 接入验证。

实现需要的原生 Transport、模型转换、历史、Usage 和交互模块。优先复用 `packages/harness-adapter/src/index.ts` 导出的校验、输出流和诊断工具；CLI 搜索复用 `packages/harness-discovery/src/index.ts`。拆文件按职责，不为统一形式添加空模块、空 `warmup` 或多余封装。

本步完成条件：公共接口能跑通真实原生操作，声明与行为一致；所有支持能力已实现，未实现项明确标注，失败与关闭不遗留活动资源。

## 3. 按范围完成加载和产品接入

- **所有插件**：按[加载、发行与验证](references/registration-and-validation.md)构建可搬移的插件，在隔离根目录显式启用，通过真实 Loader 验证；直接 `new Adapter()` 的测试不能替代插件加载。
- **仓库内实现或预装发行**：读取该参考中的 Workspace/发行分支。用户独立插件不需要修改预装清单；Host 包不得增加具体 Adapter 依赖。
- **Desktop 产品接入**：读取[Renderer 产品接入](references/renderer-product-integration.md)，处理当前静态 UI 边界；新插件路由仍用共享 codec，不新增专用编码。
- **接收委派、继续向下委派或声明完整 Agent 协调**：读取[跨 Harness 委派](references/cross-harness-delegation.md)。它复用普通可写 Thread，不另建一套执行接口。
- **新增公共能力**：同时核对类型、schema、Host 投影、使用方和测试。浏览器共享契约保持 Node-free，Renderer 不导入原生 SDK 或 Electron 私有 API。

本步完成条件：每个范围都有对应产物和验收证据；未启用的范围不做机械接线。现有 Harness 无需知道新 Harness 的私有信息。

## 4. 验证和交付

按[验证分层](references/registration-and-validation.md#验证分层)执行聚焦检查，不默认运行全仓库测试。新增插件不能以构建通过替代原生语义验证，也不能以一次聊天成功替代取消、交互、恢复和清理验证。

交付报告包含：

1. 插件位置、ID、原生接口及验证版本；入口、依赖、资源和安装/启用方式。
2. 支持、不支持、受限、未验证的能力，以及必要的认证或平台条件。
3. 实际修改了哪些插件外文件及原因；公共专用分支是否有新增。
4. 已执行检查、原生/目标环境验证；跳过或受阻检查及原因。
5. 分别标记插件后端、预装发行、Desktop 和完整委派的完成情况；不适用项写不适用。

只有范围内的实现、能力声明、测试和文档一致，才能宣布该范围完成。发现公共层缺口或原生限制时交付明确结论，不把受限实现包装成完整支持。
