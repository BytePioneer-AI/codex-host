# Tasks

组 1 和组 2 可并行，分别在独立工作树实现。组 3 须等组 1、组 2 合并并通过验收后执行。各组只修改自己涉及的文件，无法避免的重叠在交付说明中列出。

测试命令使用 `tests/vitest.config.js` 定向运行，不跑全量。

## 1. 官方后台可靠性（Host Runtime）

- [x] 1.1 按 design 第 3 节实现启动参数记录、基线和参数不同时的替换。验证：`native-account-host` 定向测试覆盖有记录、无记录、空闲替换、活动工作保留四种情况。
- [x] 1.2 按 design 第 3 节实现本机 `codex` 回退和版本下限，并把查找与 shim 拒绝逻辑搬到 `codex-runtime/`。验证：定向测试覆盖 Desktop 优先、仅本机、shim 拒绝、版本过低。
- [x] 1.3 按 design 第 4 节实现未处理服务端请求的失败规则。验证：`native-client-channel.test.ts` 覆盖 Desktop 在线不回答、离线立即回错并提示。
- [x] 1.4 按 design 第 5 节实现写入占用时退回只读。验证：定向测试覆盖冲突时快照可读且标记不可发送、释放后可发送。
- [x] 1.5 按 design 第 6 节修复 #772 遗留问题。验证：定向测试覆盖归档撤销后续聊、投递失败后重复回应报错。

## 2. Host 合约与 Web（统一入口）

- [x] 2.1 按 design 第 1 节用方法表替代 `nativeMethods`，并实现官方 Thread 的队列、置顶和用量放行。验证：`client-channel` 定向测试覆盖官方与外部 Thread 的路由。
- [x] 2.2 按 design 第 1 节实现模型、Thinking、权限选择及 inspect 的官方结果。验证：定向测试确认未收到 `thread/settings/updated` 时不显示新值，权限选项来自官方档案列表。
- [x] 2.3 按 design 第 1 节实现 `/compact`、`/review` 和 Skill 目录。验证：定向测试覆盖官方命令转发和目录内容。
- [x] 2.4 按 design 第 2 节把 `codex` 加入 Web 目录并实现新建，包括无项目目录。验证：`packages/web-server/test` 定向测试和 `browser/ch-native-codex.test.ts` 覆盖选择器与新建。
- [x] 2.5 删除 `ch-sessions.ts` 的原生特判，改为按能力显示控件。验证：`grep -n '"codex"' packages/web-server/src/ch-sessions.ts` 仅剩所有者映射；Web 定向测试通过。
- [x] 2.6 更新 `docs/product/standalone-web.md`、`docs/architecture/host-client-channel.md`。验证：文档描述与 spec 一致，`npm run lint` 通过。

## 3. 删除与验收（组 1、2 合并后）

- [x] 3.1 实测四个场景：Desktop 先开、Web 先开、Desktop 全程关闭、两端同时操作同一 Thread。验证：记录每个场景的结果和实际模型请求情况。
- [x] 3.2 按 design 第 7 节删除 Adapter 及配套机制，加入旧记录过滤，并更新预装清单、`tsconfig.json`、`docs/index.md` 与相关文档。验证：`grep -r "codex-cli" packages apps scripts --include='*.ts' --include='*.tsx' --include='*.json'` 仅剩 `RETIRED_HARNESS_IDS`；`npm run typecheck`、`npm run lint` 通过；插件冷加载测试通过。

验收记录（2026-11-08）：用户在本会话确认“实测通过”，覆盖此前约定的四种启动与双端场景，以及原生命令、Skills、Fast 与置顶同步。此为用户实测确认；未提供逐场景日志或模型请求明细，不将其记作代理执行的测试。
