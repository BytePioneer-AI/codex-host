# Pi 能力清单（本轮验证范围）

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | pi |
| 原生接口与传输方式 | Pi 原生 RPC；gotgenes 公开服务与生命周期事件 |
| 已验证的原生版本 | Pi 1.4.0 / @gotgenes/pi-subagents 25.0.1 源码与父子历史 |
| 交付范围 | 既有 Pi Adapter 的原生子代理适配修复 |
| 参考插件 | 复用现有 Pi nicobailon 子代理公共映射及只读 transcript |
| 最后验证 | 2026-10-27，macOS；现有 Codex 订阅 Astra/high |

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A2 | 工厂 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A3 | 检查 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A4 | 创建 Session | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A5 | 执行 Turn | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A6 | 取消 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A7 | 只读快照 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A8 | 持久身份 + resume | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A9 | 错误与并发 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A10 | 关闭 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B1 | 切换 Model | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B3 | 权限模式 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B5 | Fork | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B9 | 审批 | 原生有则必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B10 | 提问 | 原生有则必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 受限 | pi-gotgenes-subagents / extension / history | 公开服务、事件、真实父子 JSONL、定向回归 | 身份、状态、只读 transcript；GUI 由集成负责人验收 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
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

## 受限与已知缺口

本清单补记于既有 Adapter 修复；未影响的能力本轮不重新验收，因此明确列为待验证，不代表原实现不支持。只声明子代理修复实际覆盖范围。Desktop 真实显示由集成负责人验证。

## 插件外改动

对应 docs/harnesses/pi/pi-subagents.md 功能说明及 docs/index.md 链接描述；不新增公共合同或 Harness 专用 Host/Renderer 分支。

## 验证记录

- `npm run typecheck`、`npm run build:typescript` / `build:plugins`、定向 ESLint / Prettier、boundary 检查通过。
- 受影响的 history / RPC / adapter / gotgenes 回归通过；最后的 widget 归属修复重新执行 RPC / adapter 2 文件 148 项通过；既有 nicobailon 子代理分支的前置定向回归亦通过；新增 gotgenes 测试覆盖机器协议、事件生命周期、父历史不能覆盖实时状态、角色保留、真实子文件归属、服务被同进程 child 覆盖、switch/shutdown 与资源回收。
- 在仓库外的临时插件根用公共 Loader 读取真实合成父历史：2 个 collab 卡片，2 份真实子 transcript，无可写 checkpoint。另一次真实新回合（父子均 Astra/high）验证 running → completed、运行中与终态 child transcript、父子结果标记和资源回收；公共投影输出 7 条 collab 消息。未据此宣称 GUI 已显示正确。


- 真实组合测试验证 process 自动唤醒、子代理通知与取消交错、deferred 自主轮及用户替换输入；Pi 1.4 原型无模型复现保留了 agent_settled 后 get_state 为 Streaming 的合法事件次序。精确 AbortSignal error 形状经原始历史重放核对，取消状态不再被重开误标为失败。
