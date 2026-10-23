## 0. 实现前核对

- [ ] 0.1 核对 Pi/OMP 会话文件条目与 RPC `getEntries()` 一致（未做；读取器直接对文件行调用 `piUsageRecord`/`ompUsageRecord`，结果已与独立脚本逐条一致）。
- [x] 0.2 读取能力只依赖环境变量与文件系统，不触及 Adapter 的传输层、进程或会话（第一期 5 个）。
- [ ] 0.3 每个读取器用本机真实数据确认原生结构与分叉规则（第一期已核对；新增 Qoder / Qoder CN 依据各自原生 SDK 与隔离分叉测试实现，本机没有会话样本，真实对账仍是未完成的验收项，不能按其他 Harness 的格式猜测）。

## 1. 契约

- [x] 1.1 `harness-adapter`：可选只读用量读取能力（`listSources` + 指纹；`readSource` 整文件读取（续读未做）；记录含时间戳、模型、Token、记录 ID）。
- [x] 1.2 `shared-contracts`：统计、总览、进度的方法与 schema；加入控制台方法白名单。

## 2. Host

- [x] 2.1 解析缓存（数据目录，带版本号，损坏或版本变化即重建）。
- [x] 2.2 汇总：日期 × Harness × 模型；兜底去重。
- [x] 2.3 读时计价；未计价模型与 Token 量；费用下限语义。
- [x] 2.4 预热、过期后台重读、首次读取进度；Host 方法（`app-server-host.ts` 只增路由，逻辑在 `usage-statistics.ts`）。
- [x] 2.5 官方 Codex 改为独立 `codex-usage` 插件：原生记录与累计检查点配对、累计求差、分段合并、归档副本前缀判定、压缩与子代理边界、缓存口径；Host 不内置读取器。
- [x] 2.6 公共 Loader 支持 `kind: "usage"` 与 `createUsageStatisticsAdapter`，无需 Session 方法；复用启用、隔离、关闭、汇总与计价，不加入聊天路由。
- [x] 2.7 Codex 本机只读核对：795 个文件 / 792 个 Thread 源 / 34,289 条请求；明确请求 9,929 条和旧计数器 24,360 条的 Token 合计分别与独立脚本一致。三份公开的原生脱敏样本、搬移 Bundle、真实 Loader 和 Host 计价路由测试通过。
- [ ] 2.8 运行中 Desktop 的可见验收与实际部署（未重启用户 Desktop/Host）；按字节续读仍未实现。

## 3. 读取器（第一期：3.1–3.2 与 CodeBuddy/WorkBuddy；第二期：2.5 官方 Codex；第三期：其余）

- [x] 3.1 Claude Code（含子代理与 workflows）。
- [x] 3.2 Pi、OMP（分叉副本保留原请求 ID，由 Host 去重；含子代理会话文件）。
- [ ] 3.3 OpenCode（`opencode.db`，V1/V2 与迁移）、ZCode（`db.sqlite`）。
- [x] 3.4a CodeBuddy、WorkBuddy（含子代理转录）。
- [ ] 3.4 DeepSeek Harness（含 zstd 与 seed 边界）、Grok（`turn_completed`）、Hermes。
- [x] 3.5a 第一期 5 个读取器：本机真实数据与独立只读脚本逐项一致（Claude 10407、Pi 62790、OMP 833、CodeBuddy 127、WorkBuddy 266 条请求）。
- [ ] 3.5 后续读取器的同等核对。
- [x] 3.6 Qoder / Qoder CN：沿用可选能力接线，分别扫描各自原生目录；输入加回缓存，按消息 ID 合并内容块，跳过原生分叉复制记录。覆盖目录隔离、无进程读取、子代理、异常字段、取消、指纹，以及两套原生 SDK 的隔离分叉测试。
- [ ] 3.7 Qoder / Qoder CN 真实会话独立对账（本机两个默认目录均无会话文件；隔离测试不替代真实验收）。
- [ ] 3.8 Kimi Code：已有用量桶依据，但缺本机 wire 日志来验证每请求时间、身份、模型和分叉；保持能力缺省。
- [ ] 3.9 Antigravity：尚缺可离线解析的原生请求用量；不读取 Host 镜像充当全部原生会话。
- [ ] 3.10 Kiro CLI / Cursor CLI：本机数据与参考源码未确认可靠 Token 来源；不把 credits、上下文比例或会话数量当作 Token，不增加空读取器。

## 4. 界面与文档

- [x] 4.1 设置页“用量统计”：时间范围、总览（Token、缓存命中、费用）、按日趋势（Harness、模型筛选）、按 Harness 与按模型分解、未计价补价。
- [x] 4.2 更新 `docs/` 与 `docs/index.md`。

## 5. 验证

- [x] 5.1 分叉副本去重、指纹增量、缓存重建、失败隔离、计价下限与未知缓存的单元测试。
- [x] 5.2a 隔离环境 GUI 验证（真实读取器读本机数据）；首次读取耗时测量。
- [ ] 5.2 增量耗时测量；真实 Host 进程链路验证。
