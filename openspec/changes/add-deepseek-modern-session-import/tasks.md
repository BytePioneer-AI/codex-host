## 1. OpenSpec 与 rc.1 证据

- [x] 1.1 定义 exact rc.1 Modern-only 候选、mapping-only 导入、设置页、错误、竞争、恢复和非目标
- [x] 1.2 对照 rc.1 源码与官方 E2E 调用确认 `session/list`、`{ _request: {} }`、响应字段、排序和 cold-safe 语义
- [x] 1.3 用隔离 exact rc.1 compiled artifact 和 `DSH_HOME` 做脱敏 raw probe，并记录 package/tag/commit/lock 证据
- [x] 1.4 运行 `openspec validate add-deepseek-modern-session-import --strict`

## 2. Modern Adapter 候选目录

- [x] 2.1 新增 Modern-only `session/list` reader/parser，限制 response、节点、深度、item 和字段长度
- [x] 2.2 精确发送 `{ _request: {} }`，解析 root/Fork/Subagent/blank/running/cwd/title并保留 authoritative order
- [x] 2.3 在 Modern Adapter 与公共 DeepSeek Facade 暴露窄方法；Legacy 返回 unsupported且不调用 Legacy transport
- [x] 2.4 覆盖 valid、malformed、duplicate、invalid cwd/time/title、unknown projection、exact/oversize bound、Remote failure 和 close

## 3. Fixed Contracts 与 Host mapping 事务

- [x] 3.1 增加 strict browser-safe list/import Params/Result Schema；import params 只允许 nativeSessionId
- [x] 3.2 新增 Modern Session importer，list 时排除 Mapping Store 已映射项
- [x] 3.3 import 时重新 native list、重新查 mapping，并校验 eligible/non-running 新鲜状态
- [x] 3.4 使用 nativeSessionId single-flight、重复成功幂等和 Store-wide Native Session 唯一兜底
- [x] 3.5 用 `createProvisional` → `commitNative(..., [])` 写 paginated/non-ephemeral/default-carrier ready mapping
- [x] 3.6 失败时清理 provisional；ready 后的导航/resume失败不得删除 mapping
- [x] 3.7 注册两个固定 AppServerHost 方法并让每个成功连接至多发送一次 `thread/started` notLoaded 投影
- [x] 3.8 证明导入阶段未调用 open/readSnapshot/register 或 DSH create/fork/prompt/cancel/select/command

## 4. 设置页与本地导航

- [x] 4.1 在 RendererModelClient 增加两个 method-specific 可选方法并通过 Shared Schema 校验
- [x] 4.2 将请求绑定到 `modelClientForHost("local")`，当前 Composer 位于 Remote Host 时也不得远程导入
- [x] 4.3 在 Connections 与 Updates 之间注册“会话导入 / Session Import”页面，不增加嵌套 Dialog
- [x] 4.4 实现 loading/unavailable/empty/error/ready/importing、刷新、running disabled和跨 remount 双击保护
- [x] 4.5 实现紧凑 title/time/cwd/short-id 行、中英文案、ARIA、focus 和窄窗口布局
- [x] 4.6 抽取 Fork 已有 sidebar opener，严格匹配 local Host + returned Thread ID并清理 abort/timeout observer，同时保持 Remote Fork 原行为
- [x] 4.7 导入成功后打开标准 Thread；stale/timeout 不重试导入、不撤销 mapping

## 5. 聚焦测试

- [x] 5.1 Shared Contracts 覆盖 exact shape、边界、额外字段拒绝和 browser bundle
- [x] 5.2 Host 覆盖 mapped exclusion、fresh revalidation、busy/disappeared、幂等、跨 Host 竞争和所有 persistence rollback
- [x] 5.3 断言 ready record 的 Native Ref、cwd/title、default carrier、paginated、non-ephemeral 和 empty mappings
- [x] 5.4 断言 `thread/started`/`thread/list` 立即可见，并且第一次标准 resume 才恢复 Snapshot和补齐 Turn mappings
- [x] 5.5 Settings DOM/Vitest 覆盖六种状态、local-only、刷新、stale result、running、双击、成功及导航失败
- [x] 5.6 Thread opener 覆盖已存在/延迟行、Host ID 冲突、abort、timeout，并保持 Local/Remote Fork 原测试通过
- [x] 5.7 Legacy exact rc.2 只跑负向测试：import unsupported、无 Legacy list/open、无新 mapping

## 6. exact rc.1 Gate 与收尾

- [x] 6.1 隔离准备 idle root、blank、Subagent、running 和普通 Fork Session，核对候选规则
- [x] 6.2 导入一个 idle Session，确认只新增一条 ready mapping且 DSH artifact/event hash未变化
- [x] 6.3 打开导入 Thread，确认完整历史、同一 nativeSessionId、懒补齐 mappings并继续下一轮
- [x] 6.4 运行受影响 workspace typecheck、聚焦测试、browser boundary、Prettier和 `git diff --check`
- [ ] 6.5 不使用浏览器自动化；由用户通过 `npm start` 完成最终真实视觉与交互测试
- [ ] 6.6 父 PR 合并后 rebase upstream main并重复聚焦 Gate；Ready 前运行 `npm run check`
- [x] 6.7 审查相对父分支全部文件，确认除全局唯一索引所需的 Store-wide 写队列外，无 Legacy、其他 Harness、DSH源码、通用 Adapter、Store Schema、依赖或 lockfile越界
