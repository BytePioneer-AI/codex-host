---
name: codexhost-add-harness
description: 为 codexhost 新增 Harness 插件，或规划、审查、补全现有 Harness Adapter。开发前在插件中建立带必做与优先级的能力清单 CAPABILITIES.md，按接口规范实现原生能力，交付时以该清单供审查；区分用户插件、预装发行、Desktop 产品接入和公共契约扩展；不用于单纯添加 Model、Provider 或账号。
---

# 新增 codexhost Harness 插件

目标：交付一个**只通过公共契约工作**的独立插件。插件是交付与加载单元，`HarnessAdapter` / `HarnessSession` 是运行时接口；不要求继承基类，也不要求使用 ACP。

代码路径以仓库根目录为基准，`references/` 链接相对于本 Skill。**接口签名、字段限制以源码为准**；本 Skill 回答「要实现哪些功能、每项遵守什么规范、怎样验收」，不是第二份类型定义。

## 架构边界

```text
Host（公共）
├─ 发现 Manifest、读取 enabled.json、调用插件工厂（Cordis 作用域管理生命周期）
├─ 通过 HarnessAdapter / HarnessSession 执行业务
└─ 拥有 Thread 映射、持久化事务、预热、空闲释放、委派、用量计量、Desktop 协议投影
             │ 公共契约（harness-adapter + shared-contracts）
             ▼
插件（你的代码）
├─ Manifest：身份、版本、展示、安装指引、入口
├─ 工厂：把 HarnessPluginContext 转成原生构造参数，挂上安装/更新能力
├─ HarnessAdapter：检查、打开 Session、可选的目录/账号/统计/导入能力、关闭
└─ HarnessSession：执行、有序输出、状态、历史、关闭
             │ 插件内部
             ▼
原生 SDK / RPC / Gateway / ACP / CLI / 桌面应用内置 CLI
```

- 所有插件共用动态 Loader，Host 不静态依赖任何 Adapter 包。
- Desktop 的 Picker、图标、设置连接页、安装/更新、模型/Thinking/权限控件、Thread 恢复都由**插件目录 + inspect 结果**驱动。新插件使用共享路由时不需要改 Renderer。
- `renderer-binding-probe.ts` 等处按 ID 的分支只是旧 Thread 编码的兼容读取，**不是新插件的模板**。

## 改动边界：默认只改插件目录

| 场景 | 允许修改 | 不应修改 |
|---|---|---|
| 用户独立插件 | 只有插件目录；放入用户插件根并写 `enabled.json` | 仓库任何文件 |
| 仓库内预装 | 插件目录 + 发行配置（`tsconfig.json` references、`scripts/release/harness-plugins.json`、lockfile）+ 文档 | Host / Renderer / protocol-core 公共代码 |
| 公共契约缺口 | 按[公共扩展规则](references/packaging-and-validation.md#公共契约扩展)设计通用能力 | 新 Harness 专用的 Host 分支、专用 codec、按 ID 判断 |

需要改公共代码时，先确认公共契约确实无法表达该原生能力，并记录缺口；不得以「接入更快」为由增加 Harness 专用分支。

## 1. 建立能力清单（必做，先于编码）

1. 把[能力清单模板](references/capabilities-template.md)复制到插件目录的 `CAPABILITIES.md`（仓库内为 `packages/adapters/<id>/CAPABILITIES.md`）。
2. 对照[能力总表](references/capability-inventory.md)的「必做」「优先级」列和接口说明，**逐行**填写「结论」（支持 / 不支持 / 受限 / 待验证 / 不适用），并在「证据」或「备注」中写原生依据（文档、源码、实测命令）。不允许跳过任何一行。
3. 按优先级安排实现顺序：先完成全部 P0，得到可运行的版本；再完成 P1，之后才能交付；P2 可以放到后续迭代。

同时核对：

- 目标 Harness 当前的原生接口、版本、认证与运行方式。可行时优先用原生 SDK / RPC / 服务；只有缺少原生接口时才用 ACP，并记录能力差异。不要因为 CLI 名称相似就推断协议兼容。
- 在[实现导航](references/implementations.md)中按传输方式选最接近的参考插件；只参考对应的单点，不整包复制。
- 接口成员速查：[接口索引](references/interface-index.md)。

输出计划：

```text
交付范围：用户插件 / 预装发行 / Desktop 产品接入 / 完整委派（可组合）
原生接口与验证版本：……
能力清单：CAPABILITIES.md 已建立，列出 P0 / P1 / P2 中结论为「支持」的项
参考插件：……（各参考哪一点）
插件外改动：无 / 发行配置 / 公共扩展（逐项说明原因）
```

完成条件：`CAPABILITIES.md` 中每行都有结论；「支持」有原生依据和对应接口；「待验证」既不当作已实现，也不当作不支持；必做行没有「不支持」（A8 例外，见总表）。

## 2. 按规范实现

按 `CAPABILITIES.md` 的优先级实现，每项能力遵守对应的规范文档：每完成一项，就在清单中补上「实现位置」和「证据」。

| 区域 | 规范 |
|---|---|
| inspect / open / execute / 配置 / 错误 / 并发 / close | [会话核心](references/spec-session-core.md) |
| Turn / Item 时序、内容映射、Interaction、故障、自主 Turn、Subagent | [输出与交互](references/spec-output-interactions.md) |
| 身份、快照、resume、Fork、Rollback、导入 | [身份与历史](references/spec-history.md) |
| 用量计量、全局统计、账号额度 | [用量与账号](references/spec-usage-accounts.md) |
| 预热、空闲释放 | [预热与空闲释放](references/spec-prewarm-idle.md) |
| Manifest 展示、安装、版本检查与更新、启动路径 | [连接页](references/spec-connections.md) |
| 接收委派、向下委派、CLI 发现 | [委派](references/spec-delegation.md) |
| Desktop 展示与验收 | [Desktop](references/spec-desktop.md) |
| Manifest、工厂、打包、发行、验证分层 | [加载、发行与验证](references/packaging-and-validation.md) |

通用要求：

- 不支持的能力：能力字段声明为 false，对应操作返回类型化 `unsupported`，可选方法直接不提供；**不伪造成功、不提供空实现**。
- 优先复用 `@codexhost/harness-adapter`（输出流、交互校验、Usage 解析、导入工具、诊断脱敏）和 `@codexhost/harness-discovery`（可执行文件发现、安装器、版本管理）。
- 按职责拆分文件，不为统一形式添加空模块。

完成条件：公共接口能跑通真实原生操作；声明与行为一致；失败和关闭不遗留进程、流、订阅或定时器。

## 3. 接入加载与发行

- **所有插件**：构建可搬移的 ESM 产物，在临时隔离根目录用真实 Loader 加载验证。直接 `new Adapter()` 的测试不能代替插件加载验证。
- **预装**：修改发行配置，执行 Bundle 与 payload 验证，详见[加载、发行与验证](references/packaging-and-validation.md)。
- **Desktop**：按 [Desktop 验收](references/spec-desktop.md)做真实 UI 验证。正常情况下不需要改 Renderer；如果发现必须改，说明这是公共缺口。

## 4. 验证与交付报告

按[验证分层](references/packaging-and-validation.md#验证分层)执行聚焦检查，不默认运行全仓库测试。构建通过不能代替原生语义验证；一次聊天成功也不能代替取消、交互、恢复和清理验证。

交付报告：

1. 插件位置、ID、原生接口及验证版本；入口、依赖、资源、安装/启用方式。
2. **`CAPABILITIES.md` 的最终状态**：每行都有结论、实现位置和证据，「受限与已知缺口」「插件外改动」「验证记录」三节已填写，并逐条满足总表的[审查规则](references/capability-inventory.md#审查规则)。该文件随插件源码一起提交，供审查使用。
3. 插件外改动清单及原因；是否新增公共扩展；确认没有新增 Harness 专用分支。
4. 已执行的检查、原生环境验证；跳过或受阻的检查及原因。
5. 分别标注用户插件、预装发行、Desktop、完整委派的完成情况；不适用的写「不适用」。

只有能力声明、实现、测试和文档一致，才能宣布该范围完成。受限实现不能包装成完整支持。
