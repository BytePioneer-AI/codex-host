# Tasks

## 1. Web 目录与执行接线

- [x] 1.1 在 `packages/web-server` 增加聚焦的 Web 原生命令薄适配，从 `ChSessions` 的已确认 canonical external Thread 读取 `codexhost/thread/commands/inspect`，按命令 ID 转发 `codexhost/thread/command/execute`，保留 `kind`、`argumentMode`、`source` 及接受/错误语义。拒绝未发送草稿和不支持来源，不开放 `codexhost/harness/commands/inspect`，不改 Host/Adapter 或客户端通道白名单。验证：新增 `test/ch-harness-commands.test.ts`，覆盖归属、静态/动态目录、未知命令、忙状态、断线及查询不创建/恢复 Session；同步维护 `docs/architecture/harness-command-integration.md` 的 Web 接线边界。

## 2. 统一菜单与原生命令选择

- [x] 2.1 在 `ui-codexhost` 的产品接线中复用现有 `/` 触发器、加号入口及弹层（共享 `#` 别名增量见 7.1），增加原生命令/Skills 分组，保留 Host 公共目录形状，不把原生条目直接转换成 DSH 的默认执行语义。打开时刷新、搜索时本地过滤；增加来源提示、错误/重试、禁用原因和会话/连接代次隔离。对已占用的界面调用名显示冲突而不重复注册。验证：扩展 `test/browser/composer-commands.test.ts` 或新增相邻聚焦用例，覆盖 390/1280 宽度、键盘、同名冲突、草稿无查询、静态来源、查询失败不影响其他分组、迟到结果不串会话；更新 `docs/product/standalone-web.md` 的菜单及支持范围。
- [x] 2.2 接入选择行为：无参数命令及菜单 `/compact` 走直接命令接口；其他文本命令以公共 command carrier 引用经普通 Composer 显式提交，由 Host 在附件整理后还原原生调用（最终接线及附件回归见 5.1），保留参数原文，不经 Web 界面命令执行器接管。保护正文、引用、附件、取消/撤销及未知结果不重发，禁止忙状态下自动停止或排队直接命令。验证：新增浏览器请求断言，确认直接执行不调用 `session/prompt` 或触发附件提交，文本命令仅显式发送后调用普通提交；覆盖拒绝、双击、断线、手工 `/compact 参数`、现有队列与 Steer 不回归；同步补充 Web 文档的执行语义。

## 3. 委派 Agent 列表与引用

- [x] 3.1 从 Web 已有就绪 Harness 目录接入“委派 Agent”分组，复用展示顺序、图标和名称，按 Harness ID 保持身份并区分同名目标；不新增官方 `codex` 特例，不改写 `codex-cli`，不排除同 Harness 目标，不为菜单额外逐个 inspect。验证：隔离目录与浏览器用例覆盖就绪/不可用/用量插件过滤、名称与 ID 搜索、同名目标、目录更新、命令查询失败时仍可选 Agent、草稿无新增分组，确认仅打开菜单无启动或模型请求；同步记录首版候选并非 CLI 全量目录的限制。
- [x] 3.2 复用 `shared-contracts` 导出的 `formatDelegationMentionLink` 等现有委派 carrier 契约及 Web 输入引用能力；选择仅插入目标引用，发送时沿普通消息路径原样携带 `[@名称](subagent://codexhost.<id>)`，不新增客户端委派执行、教程注入、目标配置或 watch。验证：新增 `test/browser/delegation-agent-menu.test.ts`，覆盖光标位置、多目标、删除/撤销/复制、正文与附件保留、目标失效、发送拒绝及未知结果；断言点击无 `turn/start`、Harness 切换或委派请求，显式发送携带真实目标 ID；复用既有 Host 委派引用测试验证消费边界，更新 Web 文档的引用及委派说明。

## 4. 定向验收

- [x] 4.1 按实际 diff 执行最小充分检查并核对两份 spec 的全部场景：使用根 `package.json` 的 `typecheck`、`build:web:ui`，按 `packages/web-server/package.json` 的 Node/tsx 配置执行新增网关与浏览器文件，回归 `composer-commands` 和受影响的 Thread 引用测试；用仓库 Vitest 配置定向运行已有委派 carrier/Host rewrite 测试。如涉及依赖方向则执行 `lint`。检查文档与实现一致，记录真实 Harness 和其他平台未验收项；不运行全量套件、不启动/停止用户 Host 或 Desktop。验收必须确认没有 Host/Adapter 业务或客户端白名单变更，没有真实模型请求，也没有因前端 `accepted` 回执伪报执行完成。


## 5. 独立审查修复

- [x] 5.1 修复文本命令与文件/图片附件共存时被附件上下文挤出命令起始位置的问题。复用公共 Harness command carrier、Web 既有引用编辑和 Host restore/匹配路径，保持显式普通提交、正文/参数空白/附件/委派引用及撤销、复制、草稿恢复、queue/Steer 语义；不修改 Host/Adapter 或白名单。增加真实附件整理及真实 Host + fake Adapter 的原生命令分支回归（无附件、文件、图片、委派共存），强化浏览器断言并同步文档，记录本轮差异及验证结果后交回父会话复审。

## 6. 收尾

- [x] 6.1 移除已由 5.1 carrier 方案替代且无生产调用方的普通文本 prefix 插入字段、透传、方法及注释，保留其余菜单扩展。核对文档和任务描述，定向验证输入编辑/撤销/复制/草稿恢复、附件命令原生执行与委派引用；记录 typecheck、Web 构建、目标格式/边界结果及最终功能清单，交回父会话复审，不提交推送或归档。

## 7. GUI 习惯触发别名

- [x] 7.1 让现有原生命令、Skills 和委派 Agent source 同时响应 `/` 与 `#`，共用菜单、目录缓存、订阅/释放、选择及提交路径；保留 `/` 界面操作与加号入口，不新增后端或恢复 prefix 链路。按 GUI 词首规则实现 `#` 检测及编号、多井号、转义、URL、Markdown 空格等边界，同步 proposal/specs/docs；定向验证共享查询、键盘/手机、附件 carrier 与委派身份、忙状态/错误/会话及连接隔离，并回归 `/`、加号及真实 Host carrier 测试后交回父会话审查。
