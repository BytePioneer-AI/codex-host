# Pi 能力清单（本轮验证范围）

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | pi |
| 原生接口与传输方式 | Pi 原生 RPC；gotgenes 公开服务与生命周期事件 |
| 已验证的原生版本 | Pi 1.4.0 / @gotgenes/pi-subagents 25.0.1 源码与父子历史 |
| 交付范围 | 既有 Pi Adapter 的原生子代理、可见进度和流式内容修复 |
| 参考插件 | 复用现有 Pi nicobailon 子代理公共映射及只读 transcript |
| 最后验证 | 2026-10-28，macOS / Node 24；本轮未新增模型请求，既有子代理实测记录保留 |

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A2 | 工厂 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A3 | 检查 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A4 | 创建 Session | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A5 | 执行 Turn | 必做 | P0 | 受限 | Pi RPC / adapter | 请求与自主回合组合回归 | 本轮验证准入、输出和终态；Desktop 应用待验收 |
| A6 | 取消 | 必做 | P0 | 受限 | Pi RPC / adapter | 首消息前取消、旧轮收尾、close 回归 | 不误取消后继自主回合 |
| A7 | 只读快照 | 必做 | P0 | 受限 | pi-history | 真实历史候选回放 | 可见通知、phase 和命令元数据；不宣称所有快照形态已覆盖 |
| A8 | 持久身份 + resume | 必做 | P0 | 受限 | pi-adapter.ts | pi-steer-delayed-input.real.test.ts；pi-adapter.test.ts | 晚到插话故障后恢复同一 Session，历史身份不变；其他平台待验收 |
| A9 | 错误与并发 | 必做 | P0 | 受限 | Pi RPC / adapter | pi-steer.test.ts；异步预检竞争、typed sessionBusy 回归 | 写入前拒绝与结果未知分开；晚到输入不报成功、不自动重试 |
| A10 | 关闭 | 必做 | P0 | 受限 | pi-rpc-session.ts / pi-adapter.ts | pi-steer.test.ts；pi-steer-delayed-input.real.test.ts | 等待专属进程退出后完成晚到插话恢复；未验所有 OS |
| B1 | 切换 Model | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B3 | 权限模式 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B5 | Fork | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 受限 | pi-history / pi-tool-command | 命令元数据、旧文件输出回归 | 本轮不扩充媒体输出能力 |
| B9 | 审批 | 原生有则必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B10 | 提问 | 原生有则必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 受限 | pi-gotgenes-subagents / extension / history | 公开服务、事件、真实父子 JSONL、定向回归 | 身份、状态、只读 transcript；GUI 由集成负责人验收 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | Pi RPC / adapter lifecycle | 原生 agent_start 到终态组合回归 | 实时观察、稳定身份；应用后 Desktop 验收待完成 |
| B13 | 会话用量 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B15 | 接收委派 | 必做（验证项） | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C1 | 展示元数据 | 必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C2 | 手动安装指引 | 必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C3 | 版本检查与更新 | 必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C4 | 首次安装 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C6 | 会话导入 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C8 | 账号额度 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D2 | 预装清单 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D3 | 加载测试 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D4 | 文档 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D5 | 其他 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |

## 原生插话边界

- 范围：A5、A7、A9、A10；优先级 P0，结论为受限。实现位于 `pi-adapter.ts`、`pi-rpc-session.ts`，使用 Pi 原生 RPC，不新增公共契约。
- 工具执行中的正常插话保持原生入队。成功回执必须在目标原生执行尚未终结时收到；终结之后才收到的入队回执按结果不确定处理，不触发停止后重发。
- 晚到回执的恢复保留已完成 Turn 的原生历史，关闭该 Thread 专属的 Pi 进程以丢弃未执行队列，再由现有 Session 故障恢复路径恢复同一历史。不修改全局配置或其他 Thread，不声称可以撤销 input hook 已产生的副作用。
- 验证：`pi-steer.test.ts` 覆盖回执顺序、拒绝与未知结果、历史身份及清理；`test/pi-steer-delayed-input.real.test.ts` 在 macOS / Pi 1.4.0 上验证晚到输入不报成功、原 Turn 成功、专属进程退出、同一 Session 恢复后可继续且无遗留输入重放。该用例在未修复 PR 上失败，在修复版本上通过。macOS / Desktop 26.1103.31037 的隔离窗口经真实 Composer 验证正常插话、晚到输入、原轮成功、同一 Session 恢复、旧队列不自动重放及删除后普通发送；多窗口、远端和其他 OS 未验收。
- 检查记录：Pi、OMP 及 Host steering、未知交付队列与回执的定向合成测试通过；默认跳过的两个原生文件中，Pi 延迟输入用例已单独显式运行通过，OMP 原生 ask 未运行。Pi / OMP 的正常原生插话 Gate 均通过。类型检查、定向 ESLint / Prettier、boundary 与 diff 检查通过；插件重新打包后，经仓库外临时根的公共 Loader 冷加载、独立实例及关闭验证通过。

## Windows UNC 启动验证范围

- 范围：A4、A8、B5、C5 的进程启动边界；仅处理 Windows UNC 工作目录与标准 Pi CMD launcher 的组合，不改 RPC、Model、Thinking、扩展或历史语义。
- 优先级：P0；结论：受限。`pi-unc-launch.ts` 识别标准 npm 与官方 managed launcher，直接执行同一安装的 Node 入口；无法识别的 batch launcher 明确拒绝，不能静默在 Windows 目录启动。
- 证据：`pi-unc-launch.test.ts` 的 39 项回归覆盖入口与安装归属、Node 选择、原参数与环境、普通目录不变、UNC 新建／恢复／Fork 参数；真实 Node 子进程验证字面 argv、工作目录及 managed 版本与环境选择。Pi command / RPC / Adapter 合计 4 文件 212 项通过。
- 构建与加载：Pi 生产构建、完整类型检查、定向 ESLint / Prettier、boundary 检查通过；候选 Bundle 在临时隔离根经公共 Loader 冷加载，创建／关闭未启动原生进程或请求模型。
- 限制：本地为 macOS / Node 24.18.0；Windows／WSL 实机验证未执行，跨平台合成回放不作为实机通过。保留既有 Native Session 的目录，不把 Windows Pi 自动切换为 WSL 内的 Pi。
- 插件外改动：`docs/architecture/harness-executable-discovery.md` 补充此启动边界；无 Host、Renderer、共享契约或其他 Adapter 改动。

## 受限与已知缺口

本清单补记于既有 Adapter 修复；未影响的能力本轮不重新验收，因此明确列为待验证，不代表原实现不支持。声明子代理修复及下述输出修复实际覆盖范围。Desktop 插话已在隔离窗口验收；其他能力仍按各项记录界定，不把候选插件通过验证当作已在日常窗口生效。

## 插件外改动

对应 docs/harnesses/pi/pi-subagents.md、pi-progress.md 功能说明及 docs/index.md 链接描述；原生插话边界补充 `docs/harnesses/pi/pi-steer.md`、`docs/architecture/external-thread-steering.md`。不新增公共契约或 Harness 专用 Host/Renderer 分支。

## 验证记录

- `npm run typecheck`、`npm run build:typescript` / `build:plugins`、定向 ESLint / Prettier、boundary 检查通过。
- 受影响的 history / RPC / adapter / gotgenes 回归通过；最后的 widget 归属修复重新执行 RPC / adapter 2 文件 148 项通过；既有 nicobailon 子代理分支的前置定向回归亦通过；新增 gotgenes 测试覆盖机器协议、事件生命周期、父历史不能覆盖实时状态、角色保留、真实子文件归属、服务被同进程 child 覆盖、switch/shutdown 与资源回收。
- 在仓库外的临时插件根用公共 Loader 读取真实合成父历史：2 个 collab 卡片，2 份真实子 transcript，无可写 checkpoint。另一次真实新回合（父子均 Astra/high）验证 running → completed、运行中与终态 child transcript、父子结果标记和资源回收；公共投影输出 7 条 collab 消息。未据此宣称 GUI 已显示正确。


- 真实组合测试验证 process 自动唤醒、子代理通知与取消交错、deferred 自主轮及用户替换输入；Pi 1.4 原型无模型复现保留了 agent_settled 后 get_state 为 Streaming 的合法事件次序。精确 AbortSignal error 形状经原始历史重放核对，取消状态不再被重开误标为失败。

## 可见输出验证范围

- `display:true` custom 通知在活动回合和历史恢复中映射为 `commentary`，隐藏消息不展示；原生重试与扩展 `notify` 显示来源和实际内容；`setStatus` 临时页脚更新不写入对话，公共协议没有可替换的状态槽。
- 最终正文保留原生 phase，通知出现在正文之后也不会把答复降为普通进度。流式内容按块核对完成态，补齐合法后缀，已展示内容发生冲突时明确报错。
- 历史命令保留原生有效耗时和退出码；缺失退出码保持未知。
- 限制：完全 idle 时通知保留到下个真实回合，队列溢出明确提示；未持久化的状态不补造历史。
- Node 24.19.0：Pi 四个相关测试文件 183 项通过；流式 helper 与公共投影三个文件 51 项通过；Pi 生产构建、Pi 测试专项类型检查、Host Runtime TypeScript 构建通过。
- 候选 bundle 经公共 Loader 冷加载成功；真实既有历史的两条后台通知恢复为 commentary，命令耗时恢复为 2211ms，最终答复 phase 保持 final_answer；候选 RPC 隔离回放补齐正文和摘要后缀，未调用模型或改动安装文件。

## 自主回合准入验证

原生自动续跑从 `agent_start` 开始向 Host 公布忙状态和实时进度。异步预检后再次仲裁用户输入；已在收尾的旧轮取消不会作用于后继新轮，关闭期间当前轮的真实取消回执仍能完成入账。

2026-10-28：Node 24 下 Pi 生产构建、专项测试类型检查通过，5 个相关测试文件 194 项通过；新增 7 个真实 Adapter＋RPC 组合回归覆盖启动空档、预检竞争、递延回合、显式重试、取消、重试过程及关闭。独立代码审查确认旧轮取消与 closing 终态两项问题已解决。候选插件经公共 Loader 加载及隔离 RPC 回放，确认 `agent_start` 即 busy、自主正文在终态前发出、竞争输入没有下发、唯一终态保留原生身份。未重启或修改运行环境。
