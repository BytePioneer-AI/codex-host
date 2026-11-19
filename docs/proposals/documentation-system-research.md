# 文档体系调研与工程化建议

调研日期：2026-11-15。仓库基线：`3ade858be`，根包版本 `0.19.0`。

本文是调研与建议，不表示文档站、生成器或 CI 已实施。产品观察来自官方文档、官方源码与贡献规范；技术选型和实施顺序是结合本仓库的判断。未对样本站点进行用户测试、搜索质量评测或性能基准测试，不按页面外观猜测其技术栈。

## 1. 结论

建议采用 **同仓 Markdown + Astro Starlight 静态站 + Pagefind + 独立文档 CI**。VitePress 是轻量备选。先改善内容职责、导航和事实来源，再迁移渲染系统；不需要一次重写全部文档。

优先完成四件事：

1. 给普通用户建立“安装 → 连接 Harness → 开始会话 → 委派/远程使用 → 排障”的阅读路径，把维护者架构、提案和历史记录放到明确的独立入口。
2. 从真实契约、命令帮助和验证证据生成能力与 CLI 参考；保留人工编写的操作指南、语义解释和条件限制。
3. 用轻量文档检查补上纯文档 PR 的验证缺口，让生成内容漂移、站内死链和关键译文失效可被检测。
4. 中英文先覆盖核心用户路径；按页面指定权威原文和翻译基线，允许明确标识的缺译回退，避免强制全站双语同步。

选择 Starlight 的理由是默认静态全文搜索、多语言和缺译回退比较贴合现状。它并不内置所有复杂导航、版本管理或 API 生成能力；初期应采用默认主题和少量分组，控制插件数量。[Starlight 搜索](https://starlight.astro.build/guides/site-search/)、[多语言](https://starlight.astro.build/guides/i18n/)、[插件目录](https://starlight.astro.build/resources/plugins/)

## 2. 仓库现状与真正的瓶颈

以下为本次本地检查结果，统计不含本文：

| 观察 | 证据 | 对方案的影响 |
| --- | --- | --- |
| `docs/` 有 102 篇 Markdown；已按 architecture、product、harnesses、platforms、operations、proposals、archive 分类 | [文档索引](../index.md) | 已有按领域组织的基础，适合渐进重组；无需先大规模移动文件 |
| 同一索引同时面向使用者、开发者和调研阅读者；开头已提醒方案不代表实现 | [文档索引](../index.md) | 保留状态区分，并把它扩展到页面、导航和搜索，而非只在入口提醒 |
| 主要技术内容为中文；英文主 README，另有中文、韩文 README，以及部分中英平台文档 | [英文 README](../../README.md)、[中文 README](../project/README.zh-CN.md)、[韩文 README](../project/README.ko.md)、[SSH 指南](../platforms/remote/remote-ssh-host.md) | 不能假设所有内容都已有英文权威源；需要按页面管理原文与译文 |
| 英文与中文 README 重复维护大型能力表；插件另有能力审计清单和专项说明 | [能力边界](../harnesses/capability-boundaries.md)、[Claude Code 清单](../../packages/adapters/claude-code/CAPABILITIES.md) | 优先统一结构化事实；不要直接把审计清单中的“待验证”变成产品“不支持” |
| 已有运行时能力 Schema、原生动态目录和插件 Manifest | [能力 Schema](../../packages/shared-contracts/src/harness-models.ts)、[Cursor Manifest](../../packages/adapters/cursor-cli/manifest.json) | 可以复用类型、身份、安装元数据，但静态网页不能冒充任意会话的实时能力 |
| 预装插件由发行清单决定，其中包含 `kind: usage` 的能力插件 | [发行清单](../../scripts/release/harness-plugins.json)、[Codex usage Manifest](../../packages/adapters/codex-usage/manifest.json) | “预装插件数量”不能直接当作“可创建会话的 Harness 数量” |
| CLI 横跨 Rust Launcher 与 TypeScript Host，帮助文本和解析逻辑不是统一声明式命令树 | [Launcher](../../crates/launcher/src/main.rs)、[委派帮助](../../packages/host-runtime/src/delegation-cli-help.ts)、[委派参数解析](../../packages/host-runtime/src/delegation-cli-options.ts) | 先复用帮助输出并验证与解析一致，不假设已经接入 clap 或 Commander |
| 根包没有文档站构建脚本；代码 CI 跳过只改 `docs/**` / `**/*.md` 的 PR，Prettier 也忽略所有 Markdown | [package.json](../../package.json)、[CI](../../.github/workflows/ci.yml)、[Prettier 忽略项](../../.prettierignore) | 现有代码 CI 和格式检查不能证明文档正确；需要独立轻量工作流 |

一个具体内容问题：现有 [独立 Web 应用](../product/standalone-web.md) 同时承载产品行为和大量协议、同步、生命周期约束。建议从中提炼面向用户的启动与使用页，原文继续承担实现约束说明，二者相互链接。已有 [SSH 操作指南](../platforms/remote/remote-ssh-host.md) 的“前置条件 → 步骤 → 成功状态”结构则可以复用。

## 3. 六个官方案例：借鉴什么

这些样本同时包含开源项目与商业工具。此处比较官方文档组织方式，不把商业工具描述为开源项目，也不把页面有搜索框等同于搜索效果已经验证。

| 产品 | 官方可观察模式 | 对 codexhost 的具体启发 |
| --- | --- | --- |
| Cursor | 首页先给理解代码、规划、修复、审查等任务入口，深入后按 Agent、Customize、CLI、SDK、团队管理等领域分组 | 首页突出任务；Rules、Skills、MCP 等扩展概念建立共同入口，避免每个术语成为一级导航。[官方文档](https://cursor.com/docs) |
| Claude Code | 入门、核心概念、工作流、配置、参考、SDK 分层；不同使用环境有各自入口；扩展总览解释 CLAUDE.md、Skills、Subagents、Hooks、MCP 的用途和选择条件 | Desktop、Web、远程共享概念说明，分别提供操作路径；用“何时选什么”的比较页解释相近概念。[概述](https://code.claude.com/docs/en/overview)、[扩展选择指南](https://code.claude.com/docs/en/features-overview) |
| Raycast | Manual 按基础、核心功能、进阶、AI、账号、排障分组，并显式提供快捷键搜索；Extensions API 为另一入口 | 用户手册与 Harness 插件开发文档分入口。高频用户可以直接搜索，首次用户依靠可顺序阅读的上手路径。[Manual](https://manual.raycast.com/)、[Developers](https://developers.raycast.com/) |
| OpenCode | 当前文档提供配置及 CLI/Desktop/Web 等入口；V1 文档按 Usage、Configure、Develop 分组，明确提示旧版本并链接新版 | Harness 页面统一模板；只有主版本差异显著时才保留完整旧版入口，避免让补丁版本撑满导航。[当前文档](https://opencode.ai/docs)、[V1 文档](https://opencode.ai/v1/docs/) |
| Linear | 用户文档按需求接收、规划、Issues/Cycles、评审、自动化等工作过程组织；开发文档单独组织 GraphQL、认证、Agents、SDK | 用户导航围绕“连接、会话、委派、远程、排障”，不暴露 `protocol-core`、`mapping-store` 等源码目录。[Docs](https://linear.app/docs)、[Developers](https://linear.app/developers) |
| VS Code | 使用文档与 Extension API 分入口；扩展开发再细分上手、能力、指南、测试发布、参考；贡献规范维护结构化目录与页面元数据 | 复杂工具需要按受众提供局部目录；页面拥有稳定身份，功能生命周期可以集中校验。[Docs](https://code.visualstudio.com/docs)、[API](https://code.visualstudio.com/api)、[贡献规范](https://raw.githubusercontent.com/microsoft/vscode-docs/main/CONTRIBUTING.md) |

VS Code 的贡献规范列出 `ContentId`、`DateApproved`、`MetaDescription`、`Keywords`，并用 `feature-lifecycle.json` 管理预览、实验和弃用状态。这说明结构化元数据可以承担身份和状态管理，正文仍负责解释具体限制。codexhost 可以借鉴这一分工，不必复制其字段数量或内部发布流程。[官方贡献规范](https://raw.githubusercontent.com/microsoft/vscode-docs/main/CONTRIBUTING.md)

技术栈归属必须按源码范围陈述：OpenCode 官方 `packages/web/astro.config.mjs` 使用 Starlight，但该包导航对应 V1，不能据此推断当前 V2 主站也使用相同实现。Raycast Developers 标注 GitBook，也不能外推到 Raycast Manual。本文不推测 Cursor、Claude Code、Linear 的底层建站实现。[OpenCode 官方配置](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/astro.config.mjs)、[Raycast Developers](https://developers.raycast.com/)

## 4. 推荐的信息架构

### 4.1 受众决定入口，任务决定顺序，文档类型决定写法

Diátaxis 将文档区分为教程、操作指南、参考、解释，分别解决学习、完成任务、查找事实、理解机制的需求。适合用它约束每页职责，而不是机械地把全站拆成四个抽象大目录。[Diátaxis](https://diataxis.fr/)

建议的用户可见结构如下；这是导航结构，不要求同步改动磁盘目录：

```text
入门
  安装与升级 → 第一个会话 → Desktop / Web / 远程如何选择
  核心概念：Harness、Model、Provider、Account、Thread
使用指南
  连接与账号
  会话：继续、审批、Fork、修订
  多 Agent 委派
  Web 与远程访问
  故障排查：按症状进入
Harness
  选择与能力比较
  各 Harness：安装认证、操作、条件限制、排障
参考
  CLI、配置项、环境变量、兼容性
开发与维护
  开发环境、插件开发、公共契约、架构
  测试、发行、Desktop 兼容性维护
  调研与提案、历史归档（明确状态，单独检索）
```

第一阶段用可折叠分组和领域入口页即可。若以后采用顶栏切换并动态替换侧栏，需另行实现或评估插件，不能假设 Starlight 默认主题已提供多套分区侧栏。

导航规则：

- 核心用户任务控制在两到三层内；侧栏展示当前领域的阅读路径，页内目录展示本页步骤，二者职责分开。
- 一级顺序手工设计，Harness/API 等重复结构可自动生成。不要把文件目录完整照搬成侧栏。
- 一篇文章只有一个主要归属；其他入口用链接复用，不复制正文。稳定页面 ID 与 URL slug 不依赖中文标题，改名时保留旧链接或重定向。
- 长页面按阅读任务拆分，不按固定字数拆分；同一任务的少量 OS 差异用标签页，操作前提和流程显著不同则分页面。
- 每个领域首页提供“先读什么、常见任务、概念解释、参考、排障”，让用户无需先理解全部产品概念。

### 4.2 用选择指南解决复杂概念

沿用 [领域术语表](../project/领域术语表.md)，新增面向用户的选择说明，而不是重复定义：

| 用户的问题 | 应说明的概念与关系 |
| --- | --- |
| 我要换哪种 Agent 工作方式？ | 选择 Harness；Thread 归属 Harness，不能把换 Model 写成换 Harness |
| 我要换模型或 Thinking？ | 在当前 Harness 公布的目录中选择 Model 和选项；目录可能依赖会话状态 |
| 我要换服务端或凭据？ | Provider 与 Account 分别解释；凭据身份不等于实际 Billing Source |
| 我要从历史位置继续一条新分支？ | Fork 创建新 Thread；不自动等同于文件回滚、Worktree 或切换 Harness |
| 手机访问、SSH 和 Relay 有何区别？ | 区分界面访问通道与项目/Harness 实际执行位置；链接具体操作页 |

每篇 Harness 用户页采用同一骨架：前置条件、安装与认证、首个会话、可用能力及限制、常见故障、原生文档、验证范围。内部 SDK 协议和适配细节留给开发者页面。

### 4.3 搜索是一项需要验收的功能

建议先实现可靠的关键词全文检索，再决定是否增加 AI 问答：

1. 索引标题、摘要、章节、正文及必要术语别名；结果直接定位章节，并显示所属领域、语言和状态。
2. 默认检索当前用户文档；开发资料允许切换范围；提案、事故复盘和归档进入独立范围或不进入首期索引，避免旧实现排在当前指南前。
3. 同一概念保留中英文检索入口，例如“派生/Fork”“审批/approval”“继续会话/resume”。相关词可以交叉召回，正文仍保留 Harness、Model、Provider 的语义区别。
4. 优先匹配当前语言和版本；提供显式的“搜索其他语言/版本”，不要把旧版译文伪装成当前结果。
5. 建立至少 30 条中英文真实问题集，例如“Windows 无法启动”“Pi 权限模式”“Cursor 接收委派”“Fork 会不会改文件”“远程主机登录失败”。人工确定正确页面，评估前 3 个结果是否命中。

Pagefind 按 HTML `lang` 分语言建索引；其 extended 构建支持中文等无空格语言分词。必须锁定实际安装版本，并在生产构建上检查中文连续短语、英文 CLI 参数、中英混输；不能以“支持 i18n”代替召回验收。领域过滤和特殊结果样式可能需要配置及少量 UI 扩展。[Pagefind 多语言](https://pagefind.app/docs/multilingual/)、[Starlight 搜索](https://starlight.astro.build/guides/site-search/)

机器阅读入口可从同一发布内容生成 Markdown 和 `llms.txt`，只纳入明确标识的版本与内容状态；Claude Code 和 VS Code 已提供类似入口。它们有助于发现和读取文档，不保证 AI 答案正确，也不替代正常导航与 sitemap。[Claude Code 文档索引](https://code.claude.com/docs/llms.txt)、[VS Code 文档入口](https://code.visualstudio.com/docs)

## 5. 文档载体与技术栈比较

下面区分默认能力、官方集成和额外工程。维护成本是对本仓库的相对判断，不是框架性能排名；不使用随套餐变化的价格作为决策依据。

| 方案 | 内容与部署 | 搜索与中英文 | 版本与自动参考 | 对本仓库的取舍 |
| --- | --- | --- | --- | --- |
| **VitePress** | 开源；Vite + Vue；Markdown 可嵌 Vue；静态输出、自行托管 | 官方提供 MiniSearch 本地搜索及 Algolia 配置；内置 locale；中文分词按所选稳定版本验收 | 版本目录/发布流程自行组织；构建时数据加载适合消费生成内容，CLI/API 生成需另接 | 轻量、现有 Markdown 迁移直接；Vue 交互、中文搜索调优和缺译策略需维护。**次选**。[介绍](https://vitepress.dev/guide/what-is-vitepress)、[稳定版搜索](https://vuejs.github.io/vitepress/v1/reference/default-theme-search)、[i18n](https://vitepress.dev/guide/i18n) |
| **Starlight** | 开源 Astro 文档主题；Markdown/MDX；静态优先、自行托管 | 默认 Pagefind；内置多语路由、UI 翻译、缺译回退与提示 | 版本化、分区侧栏、TypeDoc/OpenAPI 为社区插件；可直接消费独立生成的 Markdown | 默认能力覆盖当前主要需求；保持默认主题、少量插件，维护成本较低。**首选**。[搜索](https://starlight.astro.build/guides/site-search/)、[i18n](https://starlight.astro.build/guides/i18n/)、[插件](https://starlight.astro.build/resources/plugins/) |
| **Docusaurus** | 开源 React 静态站框架；Markdown 经 MDX 编译，可嵌 React | 官方支持 Algolia DocSearch；本地搜索属社区方案；官方 i18n | 官方文档插件内置版本快照及版本导航；CLI/API 通过插件或生成文件接入 | 长期多版本维护优势明显；仅维护当前版时，版本复制与配置成本收益有限。[搜索](https://docusaurus.io/docs/search)、[i18n](https://docusaurus.io/docs/i18n/introduction)、[版本化](https://docusaurus.io/docs/versioning) |
| **Mintlify** | 商业平台；MDX + `docs.json`；Git 中可保留内容，托管发布和服务有平台依赖 | 集成站内搜索与过滤；支持多语言导航，译文仍需维护 | 支持版本分区；官方 OpenAPI 页面/请求工具及文档 CI；CLI 参考需自备来源 | 可减少建站运维，需衡量套餐、服务和导出边界；适合采购服务，非本仓库默认方案。[导航](https://www.mintlify.com/docs/organize/navigation)、[搜索](https://www.mintlify.com/docs/optimize/search)、[OpenAPI](https://www.mintlify.com/docs/api-playground/openapi-setup)、[CI](https://www.mintlify.com/docs/deploy/ci) |
| **Fumadocs** | 开源、React 组件化与内容源可组合；支持多个应用框架及静态导出 | 内置搜索及外部集成；静态部署需配置索引和客户端；提供 i18n，应用层仍有接线工作 | 支持版本 root 分区/切换，内容快照维护仍需流程；官方类型表和 OpenAPI 集成 | 适合交互开发者门户；仅发布手册时需承担更多应用工程。不能仅因产品用了 JS/TS 就优先选它。[介绍](https://www.fumadocs.dev/docs)、[静态导出](https://www.fumadocs.dev/docs/deploying/static)、[版本导航](https://www.fumadocs.dev/docs/next/navigation)、[类型表](https://www.fumadocs.dev/docs/ui/components/auto-type-table) |
| **GitHub Wiki** | GitHub 托管、可浏览器编辑；独立 `.wiki.git`；不是静态站生成框架 | GitHub Wiki 搜索、手工导航；缺少专用 locale、语言回退和检索范围配置 | Git 历史不等于产品版本站；可同步生成内容，但与代码分仓 | 开始很快，同一 PR 同步代码/文档较困难；不适合作为产品文档主库。GitHub Pages 则是静态托管载体，可托管前述开源框架产物。[Wiki 介绍](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis)、[编辑与独立仓库](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages) |

容易因旧资料而误判的细节：

- 调研时 VitePress 官网默认展示 `2.0.0-alpha.21`，并链接稳定 `1.6.4`；最新搜索文档与稳定文档的中文分词说明不同。实施时锁稳定版本，用真实问题集验证，不直接套用预发布文档的能力。[最新搜索](https://vitepress.dev/reference/default-theme-search)、[1.6.4 搜索](https://vuejs.github.io/vitepress/v1/reference/default-theme-search)
- Mintlify 已有面向 Enterprise、需申请启用的静态导出 API，不能笼统称其“绝对不能自托管”；但这也不等于开源框架的自由本地构建，导出后的动态服务能力需要单独核实。[静态导出](https://www.mintlify.com/docs/api/static-export/start-job)
- Fumadocs 当前文档列出 Next.js、React Router、TanStack Start、Waku、Astro 等适配，不能描述为“只能 Next.js”或“必须运行服务端”。静态模式仍需按其要求处理搜索。[框架介绍](https://www.fumadocs.dev/docs)、[静态部署](https://www.fumadocs.dev/docs/deploying/static)、[搜索](https://www.fumadocs.dev/docs/headless/search/orama)

框架选型不需要打一个看似精确的总分。试点应记录内容迁移量、插件数量、干净构建耗时、搜索索引下载量、中文命中率、缺译体验和本地维护难度，再决定是否偏离默认推荐。

### 推荐的代码与内容边界

- 文档继续与产品同仓、同 PR 审查。站点构建独立于 Host、Desktop 和 Rust 完整构建，不把文档站做成运行时产品模块。
- 建站配置可放独立 `apps/docs` 工具工作区，采用根仓库一致的依赖管理；实际接入时需调整 workspace 配置。此路径为建议，尚不存在。
- 正文只保留一份权威源。首批可从 `docs/` 选择发布内容，构建时暂存到站点内容目录；暂存产物不手改、不作为第二套源文档提交。若加载器可直接使用现有源，则无需复制。
- 先发布安装、核心概念、常用操作、能力边界和 CLI，按清单收录；不要把所有 `docs/**` 自动发布到用户导航。
- 保持通用 Markdown 为主，只有交互能力表等必要页面使用组件；不要让每篇文档依赖专有 MDX/Vue 组件。
- 处理好 Markdown 相对链接、图片、仓库源码链接和旧 URL。文档链接映射到站点页，源码链接指向对应提交；生成目录仍能追溯原文位置。

### 哪些条件会改变推荐

- 团队明确偏好 Vue，主要需要简单静态手册，并愿意配置中文分词与缺译策略：选 VitePress。
- 需要长期并行维护多个产品大版本和各版本翻译：Docusaurus 的内置版本化价值会上升。
- 文档要成为高度定制的 React 开发者门户，嵌入可交互 API/SDK 示例且有持续前端投入：评估 Fumadocs。
- 写作人员以非开发者为主，希望采购托管编辑、发布、搜索等服务，并接受相关预算和导出边界：评估 Mintlify。
- 临时社区笔记可以使用 Wiki；产品使用指南、能力承诺和代码参考仍保留在主仓库的受审查流程中。

## 6. 防止文档与代码脱节

### 6.1 先定义事实归属，再谈自动生成

| 内容 | 权威来源 | 自动化输出 | 必须人工负责的部分 |
| --- | --- | --- | --- |
| Harness 身份、安装入口、预装集合 | 插件 Manifest 与发行清单 | Harness 列表、安装参考、资源链接 | 原生认证前提和平台差异 |
| 会话能力的字段和语义 | 公共契约、Adapter 的实际能力计算 | 能力字段参考、受测场景结果 | 原生限制、动态条件和产品解释 |
| 支持及验证范围 | 插件声明、测试场景、Gate 的实际结果 | 带证据的能力矩阵 | 原生能力与 Host 行为的区别，未覆盖情形 |
| CLI 参数和默认值 | 所属 Rust/TS 命令定义、帮助和解析行为 | 命令参考与帮助片段 | 操作流程、示例、错误恢复 |
| 公共类型与配置结构 | 公共 exports、Zod 等现有 Schema | 白名单内的类型/字段参考 | 副作用、权限、生命周期与兼容性 |
| 教程、设计解释和排障 | 经维护者核实的行为 | 目录、链接与元数据校验 | 完整文字与读者体验 |

自动生成只能同步可枚举事实。字段存在不表示功能可用，示例能解析不表示操作成功，类型参考也不能代替教程。

### 6.2 能力矩阵：实现状态与验证状态分开

当前 [会话能力 Schema](../../packages/shared-contracts/src/harness-models.ts) 包含配置、历史、Subagent、Steering 等事实，但不是完整产品能力表；部分能力来自其他公共接口或运行时结果。不能靠扫描接口名称、可选方法或一次本机 `inspect` 推断所有平台支持。

推荐演进方式：

1. 保留 `CAPABILITIES.md` 的开发审计职责。先选择 Pi、Claude Code、Cursor 等少量差异显著的插件，提取适合公开展示的结构化记录。
2. 记录分为两个正交维度：`support`（支持、受限、不支持、动态）和 `verification`（已验证、未验证、受阻）。测试失败保留失败证据供维护者处理，不自动等价为原生产品永久“不支持”。
3. 每条记录明确描述的是原生能力、Adapter 映射还是 Desktop/Web 呈现；原生支持不自动等于两个界面均支持。受限记录包含条件、适用平台/原生版本、源码或契约来源；已验证记录还要有测试/Gate 场景、提交或发布版本、运行环境与结果。测试文件存在不算执行通过。
4. 能从纯能力计算或受控 Adapter 测试结果导出的事实直接复用；只有原生边界解释和验证条件需要补充维护。不要另写一套驱动运行时的文档能力布尔表。
5. 同一数据生成站点矩阵和 README 简表；中英文只翻译标签及说明，不各自维护状态。完整限制链接到对应 Harness 页。

一个记录的概念形状如下，字段名是建议，非现有 API：

```text
featureId + harnessId + surface
support + conditions
platforms + nativeVersionScope
implementationSource
verification: status + evidenceRef + commit + environment
```

Kimi Thinking 必须说明随会话与 Model 动态变化，不能从某次发现结果生成固定选项。Cursor 的向外委派和接收委派必须分列；Fork 也要表达平台限制。已有 [能力边界](../harnesses/capability-boundaries.md) 提供这些语义，生成工作应保留它们。

仓库已有 [Claude Gate 能力推导](../../tools/gate-claude-code/capabilities.mjs) 等机制，优先复用可用证据及场景身份，但先审查其 `supported`/`unsupported` 含义再映射成公开承诺。不能把某个 Gate 的内部结果枚举原样推广为全产品状态。

文档构建不得为获取能力启动真实 Harness、调用模型或读取用户账号。常规 CI 使用纯函数、fixture 和受控测试；需要原生 CLI/账号的验证独立运行，将脱敏的结果作为带版本证据。解析与验证逻辑归所属包或 crate，`tools/` 脚本只负责编排，跨包使用公共导出。

### 6.3 CLI 与 API 参考：两步落地

**第一步，复用现有帮助。** 从 Launcher 的帮助和 `delegation-cli-help.ts` 生成参考片段；为选定的公共命令校验帮助与实际解析行为。显式列出可安全导出的帮助入口，不用遍历命令并拼接 `--help` 的方式探测，避免有些命令不支持帮助或进入运行路径。

生成内容确定排序、行宽和换行规则，不包含机器路径、当前时间或账号值；生成后比较 Git diff，漏同步则失败。仅抓取 `--help` 可以防止网站与帮助脱节，仍不能证明帮助与解析器一致，需要针对必填参数、默认值、互斥选项及未知参数的行为检查。

**第二步，随着 CLI 的实际演进收敛声明。** 在 Rust/TS 各自所有者内让帮助、参数元数据与解析共享定义；由文档脚本聚合两侧导出。不为文档生成而把 Launcher 语义迁到 TS，不强制整体替换 CLI 框架，也不向浏览器契约塞 Node/Rust 运行时依赖。

API 参考只发布明确公共的 exports 与 Schema。TypeDoc 或 Schema 转换器属于可选工具；转换时应核对 refinement、默认值和不能表达的约束。OpenAPI 适合已定义的 HTTP 契约，不应把全部 JSON-RPC、MCP 或 Harness SDK 假装成 HTTP API。示例从可执行 fixture 或测试提取，避免在文档中复制第二份样例。

### 6.4 PR 检查：轻量、可解释、能真正阻止漂移

新增独立 docs 工作流，保留现有代码 CI 对纯文档改动的轻量策略。建议检查层次：

| 检查 | 触发与阻断策略 |
| --- | --- |
| Markdown/frontmatter、页面 ID、导航目标、站内链接/锚点、图片存在 | 相关文档改动时执行；新增错误阻断，历史存量先建明确基线，不一次性重排全文 |
| 生成文件一致性 | Manifest、发行清单、能力契约、CLI 帮助/解析或生成器变化时执行；可复现生成差异阻断 |
| 文档站生产构建 | 文档/配置变化时执行；捕获 MDX、路由、链接和资源错误，部署预览供审阅 |
| 代码与文档影响映射 | 用少量关键路径映射到功能页/owner；改到契约但未改文档时提示，作者可说明“仅内部重构，无公开行为变化”，由对应维护者确认 |
| 文档示例 | 对标记为可执行的 CLI/JSON/代码块做聚焦校验；只校验可隔离的命令，不能批量执行任意文章代码块 |
| 翻译基线与必需页面 | 关键用户页缺译或过期按发布策略阻断；一般架构译文只提醒并显示回退 |
| 外部链接、搜索问题集 | 外链定期或按新增链接检查，超时/限流重试；全站外链网络抖动不阻塞普通 PR。搜索问题集在索引配置或重要内容变化时回归 |

影响映射应覆盖真实入口，例如 `packages/adapters/*` 对应 Harness 文档、`crates/launcher` 与委派 CLI 对应命令参考、公共契约对应开发者参考。映射只提示可能受影响页面，不能靠路径规则证明叙述正确。

若把 docs check 配成必需状态检查，应让工作流在每个 PR 都报告结果，在内部判断是否需要运行重检查；不能用整条 workflow 的路径过滤造成 required check 一直 Pending。GitHub 官方文档明确说明了这种差别。[GitHub 必需检查排障](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

普通 PR 的 docs 构建在无发布凭据环境执行；正式部署单独读取可信分支产物。发布文档绑定实际产品 tag/commit，避免 `main` 上尚未发行的功能悄悄进入“当前稳定版”指南。

### 6.5 中英文：页面身份、原文摘要和过期提示

推荐采用“核心双语，深层按需翻译”：

- P0：安装/升级、首个会话、权限与账号、远程连接、关键能力限制和常见排障，要求中英文齐备。
- P1：常用功能与 CLI 说明，按变更影响补译；参数名、代码、命令和状态值来自同一数据，不翻译标识符。
- P2：架构、调研、事故复盘，保留现有中文原文；按需求补英文摘要或译文。韩文入口继续保留，但不顺带承诺全量韩文维护。

为每个页面分配稳定 `id`，原文记录 `sourceLocale`；译文记录 `translationOf` 与 `sourceDigest`（或原文 Git blob SHA）。摘要只覆盖需要翻译的正文和相关语义元数据，排除生成时间、译文自己的状态字段等噪声；文件重命名不应丢失翻译关联。一般 Git 提交时间不是“已审核日期”。

原文变化后，CI 比较摘要并生成待同步清单，译文审核后再更新基线。AI 可以起草翻译和标记差异，维护者负责术语、否定条件、权限及操作语义；“已运行机器翻译”不自动等于“已审核”。能力矩阵和 CLI 参数的结构化部分直接生成两种语言版本，避免产生两份事实源。

一页只指定一种权威原文语言。既有中文架构文档不必先翻成英文才能更新；新用户文档可以按实际主要作者选择英文或中文。站点默认语言与原文权威语言是两个不同设置。

缺译时回退到**同一产品版本**的原文并提示；已经有旧译文时标记过期，不通过回退机制把它继续显示成最新。Starlight 的内置 fallback 解决缺页问题，译文 freshness 检测仍需自建。[Starlight i18n](https://starlight.astro.build/guides/i18n/)

本次抓取 OpenCode 的当前英文入口与中文入口时，两者展示不同安装包与文档代际。这不足以断定其翻译有错，但提醒我们必须同时核对版本和语言，不能仅凭语言菜单就认定内容等价。[当前英文入口](https://opencode.ai/docs)、[中文入口](https://docs.opencode.ai/docs/zh-cn/)、[V1 英文入口](https://opencode.ai/v1/docs/)

### 6.6 版本策略：避免语言与版本相乘失控

首期只维护稳定发布文档和明确标识的开发版预览。稳定站由发布 tag 的源构建；开发版来自 `main`。历史小版本保留发行说明和重要迁移页，不为每个 patch 复制全站。

codexhost 特别需要区分三个维度：产品版本、原生 Harness/CLI 版本、Codex Desktop 兼容版本。前者决定站点发布快照，后两者放在能力与兼容性记录里；不要为每个组合建立完整文档站。

## 7. 分阶段实施与验收

下面是建议的交付切片，不是工期承诺。每阶段可单独交付，框架试点不需要等待全部自动化完成。

| 顺序 | 交付内容 | 验收条件 |
| --- | --- | --- |
| P0：内容与元数据 | 盘点当前文档；挑选 12–20 篇核心用户页；明确 current/proposal/archive、受众、权威原文；确定导航与发布清单 | 安装、连接 Harness、Fork、委派、远程、排障都有清楚入口；提案不显示为现行功能 |
| P1：最小站点 | Starlight 默认主题、静态搜索、中文/英文入口、原文链接；部署预览；建立最小 docs CI | 构建与产品运行时独立；站内链接/图片无新增断裂；中英切换保留页面身份，缺译提示明确；手机与键盘可完成导航 |
| P2：消除重复事实 | 三个代表性 Harness 的能力生成；README 简表复用；Launcher 与委派 CLI 的首批参考生成 | 同一事实只改一个来源；改命令/契约却不更新生成物能让 CI 失败；未验证结果不显示为已验证 |
| P3：扩大覆盖 | 全部公开 Harness、公共配置/API、关键译文基线、发布 tag 绑定 | 预装目录区别会话插件与 usage 插件；限制和证据可追溯；稳定站不混入未发布能力 |
| 持续维护 | 外链检查、搜索问题集、低命中文档改写、过期译文处理 | 首期目标：30 条代表问题中至少 90% 在前 3 项命中预期页；这是待验证目标，不是现有成绩 |

试点应保留相同 Markdown 内容和同一搜索问题集。如果 Starlight 在核心导航或现有链接迁移上需要过多自定义，再用同一小样本验证 VitePress；无需同时长期维护两套站点。

站点上线后的责任按内容所有者划分：插件维护者负责原生能力与限制，CLI 所有者负责参数和帮助，产品功能所有者负责操作指南，发布维护者负责版本快照，译文审阅者负责翻译基线。工具检查负责发现可机械判断的错误，内容承诺仍由对应维护者审查。
