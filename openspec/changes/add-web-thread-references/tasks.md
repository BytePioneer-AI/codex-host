# Tasks

## 1. 引用输入

- [x] 1.1 为本地共享 external 会话提供独立于排序能力的引用拖动负载，使用真实 Thread ID、显式 local 来源与安全的标题文本；增加聚焦测试验证同名不同 ID、特殊标题、无标题、隔离 Codex 与未创建草稿排除，以及最近列表可拖但不可排序。
- [x] 1.2 在 Composer 复用既有引用机制显示蓝色「会话图标 + 标题」，保留正文和附件，支持混排、整体删除及撤销，并序列化为标准文本链接；协调侧栏 dragend 防止排序或导航。通过 `packages/web-server/test/browser` 聚焦用例和截图验证蓝色行内外观、插入、多引用、跨区拖动、原有排序及文件拖放；采用现有 `test:web:browser` 配置，限定相关用例。
- [x] 1.3 在受支持会话的既有菜单增加“复制会话链接”，复用拖动目标地址生成规则；测试复制的 canonical ID 与 local 来源、成功提示、剪贴板拒绝时的失败提示、未支持来源不提供入口，以及复制后粘贴保持普通文本，不改变当前会话或草稿。

- [x] 1.4 让聊天主区域（正文、留白与输入框）统一接收有效本地共享外部 Thread 拖放，显示整区浅蓝覆盖、“松开以引用聊天”及会话图标+标题预览；松开仅向当前 Composer 插入一次并保留草稿/附件/编辑位置。以聚焦 Chromium 测试及拖动中/松开后截图验证视觉、跨子元素不闪烁、离开/取消/dragend/目标卸载清理、不可编辑及未支持来源排除、文件拖放与侧栏排序共存；同步现有文档，不发送、跳转或读取历史。

- [x] 1.5 修复已发送用户消息与队列预览的显式会话链接展示，复用已有蓝色会话图标+标题样式；通过聚焦浏览器用例及截图验证中文/转义标题、同名不同地址、刷新历史、复制消息和队列编辑的原文保留，普通文本及其他协议不被误转换；仅改展示，不自动读取或跳转，同步现有文档。

## 2. 提交与读取验收

- [x] 2.1 为既有 Web 提交链路补充聚焦测试，验证蓝色引用的剪贴板／草稿文本投影及发送序列化包含正确地址，两种 URI、裸 ID、Markdown 引用和显式远程来源按原文传递，草稿恢复、排队编辑及明确拒绝保留引用身份，未知结果不自动重发；按 `packages/web-server/package.json` 的 Node test 配置运行相关测试，不新增 RPC 或 Host 提示注入。
- [ ] 2.2 在支持 CLI 的真实本地共享外部 Harness 会话中，分别通过菜单复制后粘贴、手工粘贴 ID 和拖入另一会话，明确要求读取并核对 CLI 实际访问的 Thread ID、可见消息及目标无新增 Turn；记录真实验证结果或阻塞原因。同时更新 `docs/product/standalone-web.md` 说明蓝色行内引用、菜单复制链接、标准文本传递、来源限制和不自动读取，运行 `npm run lint` 检查改动与依赖边界。

## 验证记录

- `npm run build:web:ui`：通过；未打包发行目录、未启动或重启现有服务。
- `npm run typecheck`：通过。
- `node --import tsx --test packages/web-server/test/thread-references.test.ts packages/web-server/test/thread-reference-submit.test.ts packages/web-server/test/ch-sessions.test.ts packages/web-server/test/ch-queue-edit.test.ts packages/web-server/test/mixed-sessions.test.ts`：38 项通过。
- 沿用 `test:web:browser` 的 Node/tsx/Playwright 配置，限定 `thread-references.test.ts`、`thread-reference-queue.test.ts`、`mixed-sessions.test.ts`：8 项通过。覆盖实际 Chromium 拖动/键盘/剪贴板、蓝色图标与正文/附件混排、分组及平铺的旧排序标记取消、删除/撤销、草稿恢复、队列编辑与提交失败。Host 为隔离 fixture，文件 drop 事件为测试构造，不冒充真实 Harness 或操作系统文件拖放验收。
- 截图输出 `/tmp/codexhost-thread-references/`，已查看 `thread-reference-inline-blue.png` 的行内蓝色会话图标与标题。
- `node tools/check-boundaries.mjs` 及本变更涉及的服务端/测试文件 ESLint：通过。公共纯文本辅助模块通过显式公开子路径共享，不导入另一 UI 包的内部实现。
- `openspec validate add-web-thread-references --strict`：通过。

## 2.2 待完成与阻塞

- 已更新 `docs/product/standalone-web.md` 的“会话引用”章节，保留文件中其他任务的打包布局与启动配置改动。
- 已执行 `npm run lint`，最近一次失败为本变更之外的 9 项错误：`packages/host-runtime/src/external-thread-queue.ts` 及 `.work/otter-installer/source/` 中的对应副本存在非空断言；另一个任务的 `ch-queue-navigation.test.ts`、`ch-follow-queue-race.test.ts` 存在 void 类型用法错误。未修改、忽略或绕过这些文件；独立边界检查已执行通过。
- 上轮真实环境仅执行 CLI 帮助、当前工作区的只读 `thread list` 和 Web 的认证 `session/list` 查询。用户已确认旧的重复 4400 监听进程被其停止，当前 localhost 接口提供 `threadReference` 能力且 Chrome 已刷新；旧服务未加载能力不再作为当前阻塞依据。
- 本轮已在当前 4400 Web 的独立 Chromium 上下文中新建未提交草稿，实际验证拖入反馈与蓝色引用；没有重启或替换 Desktop、Web、共享 Host，也没有向真实会话发送消息。菜单复制后粘贴、手工 ID 和拖入三条真实 Agent/CLI 读取路径，以及对应 canonical ID、可见消息与目标无新增 Turn 的核对仍未执行；随后已按用户明确请求，通过现有 CLI 对其给出的 local 会话链接执行 `thread read --view messages --limit 2 --format compact`，成功取得 Pi 会话的两条可见消息；这是真实只读访问，不是 fixture。尚未完整执行菜单复制、手工 ID、拖入三条路径的全部核对，2.2 保留未勾选。

## 聊天主区域拖入反馈验证

- 已同步 proposal、spec、design 与现有产品文档；1.4 完成，OpenSpec 总进度 5/6。
- `npm run build:web:ui`、`npm run typecheck`、独立边界检查、聚焦 ESLint 与 `git diff --check` 通过；`npm run lint` 仍为上述 9 项范围外错误，未改动这些文件。
- 沿用 `test:web:browser` 配置限定 `thread-reference-drop.test.ts`、`thread-references.test.ts`、`thread-reference-queue.test.ts`、`mixed-sessions.test.ts`：12 项通过。新增覆盖整区蓝色提示及安全标题预览、正文松开仅插入一次且保留编辑位置/附件、子元素间不撤下覆盖、离开/重入/Escape/dragend/blur/切换目标清理、不可编辑目标、未知/远程/普通文本及文件优先级；侧栏排序和已有引用回归通过。文件拖动和强制只读状态是测试控制条件，不冒充操作系统文件拖放或真实 Harness 执行。
- Node 聚焦 `thread-references.test.ts` 与 `thread-reference-submit.test.ts`：9 项通过。
- 当前真实 Web 的认证目录查询成功，支持引用的会话数为 1777；正常页面加载的新反馈资源存在。独立真实浏览器页在侧栏执行原生鼠标拖动并松开到聊天区域，生成 1 个蓝色引用、当前目标身份不变、`session/prompt` 请求数为 0；没有注入替代 UI 或拦截替换资源。首次探测因其他会话的无限运行动画导致等待超时，排除无限动画后复测通过，不作为产品阻塞。
- 已查看截图 `/tmp/codexhost-thread-drop/thread-drop-zh-hover.png`、`thread-drop-body-inserted.png`（隔离 Host），以及 `live-hover.png`、`live-inserted.png`（当前 4400 服务）。截图覆盖悬停提示/图标标题与松开后行内引用。

## 已发送消息引用展示验证

- 1.5 完成：仅在既有 `projectUserText` 中增加显式 CH 会话 Markdown 的安全展示投影，气泡和队列复用原蓝色会话图标样式，不改输入、日志、复制或编辑文本，不增加跳转/读取。
- `npm run build:web:ui`、`npm run typecheck`、独立边界检查、聚焦 ESLint、OpenSpec strict 校验与 `git diff --check` 通过；全仓 lint 仍为前述 9 项范围外错误。
- 聚焦浏览器 `thread-reference-messages.test.ts`、`thread-reference-queue.test.ts`、`thread-references.test.ts` 共 8 项通过。覆盖截图中的中文引用、特殊字符安全展示、同名不同地址、显式远程来源、普通文本不转换、既有 DSH 引用兼容、复制完整消息、刷新历史与队列编辑原文保留。
- 已查看隔离 Host 截图 `/tmp/codexhost-thread-messages/thread-reference-sent-message.png`；另在当前 4400 服务的独立 Chromium 上下文打开本会话，已发送的真实用户消息成功显示会话图标与标题，截图为 `live-sent-reference.png`。未拦截替换资源或注入展示 UI，未重启/替换运行中的服务，未提交消息。

