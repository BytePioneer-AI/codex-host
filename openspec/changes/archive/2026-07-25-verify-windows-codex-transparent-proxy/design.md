## Context

codexhost 当前已经有 `launcher`、`shim` 和 `platform` Rust crate，但只包含链接关系测试。产品方案要求 Launcher 在不修改官方 Codex Desktop 安装的前提下设置 `CODEX_CLI_PATH`，由 Shim 接收 Desktop 的调用并透明转发到官方 Codex CLI。当前 Windows 环境已安装 Codex Desktop `26.721.4979.0`、Codex CLI `0.145.0` 和 Pi `0.82.0`，但 AppX 激活、单实例复用、环境继承、实际 argv、stdio 半关闭和进程退出行为仍未通过本仓代码验证。

本变更是 Windows Gate A，不是生产 Protocol Core。它必须同时产出可重复 Probe、最小透明代理和可审查证据；仅记录调用而不验证转发不足以关闭 Gate，直接加入 JSON-RPC 转换或 Pi 路由又会扩大到后续 change。

## Goals / Non-Goals

**Goals:**

- 在全新 Windows Codex Desktop 进程上证明进程级 `CODEX_CLI_PATH` 是否到达 Desktop 启动的 CLI 子进程。
- 用最小 Rust Launcher/Shim 保持 argv、stdin、stdout、stderr、EOF、取消和退出状态，并防止递归调用。
- 建立 hermetic 字节透明性/生命周期测试、脱敏 Fixture、官方直连差分和真实 Desktop Gate 记录。
- 无论 Gate 通过、失败或被环境阻塞，都输出足以支持下一次产品或架构决策的明确结论。

**Non-Goals:**

- 不解析、改写或路由 app-server JSON-RPC，不实现 Protocol Core 或 Harness 选择。
- 不接入 Pi，不定义 HarnessAdapter、Host Thread/Turn/Item 或 Mapping Store。
- 不注入 Renderer，不自动化正式 Agent UI。
- 不制作安装器、私有 Node.js Runtime、签名或更新机制。
- 不以 Windows 结果替代 macOS 真实安装环境验证。

## Decisions

### 1. 一个 Gate A change，分为事实捕获和透明代理两个阶段

事实捕获是第一组任务，但不单独形成只能输出日志的 change。捕获到的实际调用形状决定后续参数分类和官方 CLI 定位；同一 change 必须继续完成字节转发和差分验证，最终回答 Windows 透明接入是否可行。

替代方案是直接实现完整垂直 Demo。该方案同时引入 Pi、Renderer、Protocol Core 和持久化，任何失败都难以定位，因此拒绝。

### 2. 可复用原生机制进入 Rust crates，实验编排和证据留在 tools/tests

`platform` 承担 Windows 安装发现、进程检查、子进程环境和进程树控制；`launcher` 承担安全启动入口；`shim` 承担官方 CLI 启动与 stdio 转发。它们只实现平台和进程语义，不持有 Host/Harness 领域状态。

探测命令编排、Fixture 脱敏、差分归一化和 Gate 报告位于 `tools/`、`tests/fixtures/`、`tests/differential/`。这样既真实验证最终原生边界，又不会把实验协议假设放进正式 TypeScript packages。

### 3. Launcher 只设置本次启动的环境，不修改用户或系统配置

Launcher 首先发现目标 Desktop 安装并检查是否已有对应进程。已运行时直接失败并给出可操作诊断，不结束用户进程，也不把环境注入已有单实例。只有确认新进程后，才为本次启动构造包含绝对 Shim 路径的环境块。

Windows AppX 的具体激活方式必须由 Probe 验证。若受支持的启动方式无法传递环境，Gate 记录失败或阻塞结论，不通过修改 `app.asar`、全局环境或用户安装目录绕过。

### 4. 官方 CLI 路径由 Launcher 明确解析并传给 Shim

Shim 不通过当前 `PATH` 猜测官方 CLI。Launcher 在覆盖 `CODEX_CLI_PATH` 前解析与当前 Desktop 对应的官方 CLI 绝对路径，并通过 probe 专用、进程级配置传给 Shim。Shim 对路径做规范化，拒绝目标等于自身，并在启动官方 CLI 前清除或重写 `CODEX_CLI_PATH`。

app-server 与非 app-server 调用均保留原 argv 并转发；本变更中的分类只用于证据和测试，不引入业务路由。

### 5. Shim 是不解析协议的全双工字节泵

父 stdin 的每个字节按原顺序写入官方 CLI stdin，官方 stdout 的每个字节按原顺序写入父 stdout；不按行解析、不重新序列化、不改变换行。官方 stderr 转发到父 stderr，Shim 自身诊断也只能进入 stderr 或受限日志，stdout 禁止写入任何诊断。

父 stdin EOF 后关闭子 stdin，但继续排空 stdout/stderr。子进程退出后先排空管道，再映射退出状态。取消或 Shim 被终止时使用 Windows 进程组/Job Object 等受验证机制有界终止官方 CLI 进程树，避免孤儿进程。

### 6. 证据采集默认最小化且分为本地原始产物和可提交产物

调用记录只允许包含 schema 版本、产品版本、时间、参数分类、路径占位符、必要环境键的存在性、进程关系和退出分类。不得默认转储完整环境、Prompt、消息、Tool 输出、凭据或原始 Transcript。

原始捕获写入已忽略的本地目录；只有经过确定性脱敏和人工检查的 Fixture、Golden 摘要和验证记录可以提交。Fixture 使用专门测试 Prompt，不采集用户真实会话。

### 7. 使用三层验证，不把真实 Desktop 测试混入普通 check

1. Hermetic 测试使用可控假子进程验证 argv/env、递归防护、任意 chunk 边界、EOF、stderr、退出码和进程树清理。
2. 官方 CLI 差分测试对同一组无敏感测试输入分别执行直连和 Shim 链路；字节泵本身要求精确相等，协议结果只对非确定字段归一化后比较。
3. 真实 Desktop Gate 覆盖启动、新建、继续、流式、工具和取消，并记录当前 Desktop/CLI 版本及人工观察结果。

前两层纳入普通质量门禁；依赖真实 Codex Desktop 的测试使用独立 Gate 命令，不进入 `npm run check`。

### 8. Gate 报告允许 PASS、FAIL 或 BLOCKED，但不得把失败静默标成完成

PASS 要求调用继承、透明字节转发、生命周期和真实 Desktop 核心场景均满足 spec。FAIL 表示已证明关键不变量不成立；BLOCKED 仅用于环境或访问限制导致未能判定。FAIL/BLOCKED 都必须记录证据、影响和下一决策，且不得继续把透明代理当作已验证前提。

## Risks / Trade-offs

- [Windows AppX 激活可能复用已有进程或不继承调用方环境] → 启动前检测目标进程，只验证新实例；无法传递时明确关闭 Gate，不使用全局环境绕过。
- [官方 CLI 路径可能随 Desktop 更新变化] → 从当前安装事实解析并记录版本，不维护未经验证的版本矩阵，也不回退到任意全局 `codex`。
- [Probe 捕获可能泄露凭据或会话内容] → 环境字段采用 allowlist，原始产物保持忽略，提交前执行确定性脱敏和人工检查。
- [全双工管道在 EOF/取消竞态下死锁] → 使用独立泵和有界关闭状态机，增加半关闭、子进程先退出、父进程取消和大输出测试。
- [差分结果含动态 ID、时间或路径] → 明确归一化字段清单；未知差异默认失败，不自动更新 Golden。
- [Windows 验证通过被误解为跨平台结论] → Gate 报告和 capability 名显式限定 Windows，macOS 另建 change。

## Migration Plan

1. 保持现有空骨架公开行为不变，先增加 hermetic Probe/转发测试和本地输出忽略规则。
2. 实现 Windows 安装/进程发现及 Launch Probe，在真实环境采集第一份脱敏调用记录。
3. 依据记录实现官方 CLI 定位、递归防护和透明 Shim，再执行 CLI 差分与 Desktop Gate。
4. Gate 失败时保留 Probe、Fixture 和结论，停止后续正式路由实现；实验运行入口不得作为发布能力暴露。
5. Gate 通过后，后续 Protocol Core change 可以复用已验证的原生启动/转发边界，但必须另行设计协议接管。

## Open Questions

- 当前 Windows AppX 安装可用哪种受支持方式启动新实例并保证自定义环境继承？
- Desktop 传给 `CODEX_CLI_PATH` 的 app-server 与非 app-server argv 精确形状是什么？
- 与当前 Desktop 匹配的官方 CLI 位于何处，是否存在多个架构或辅助调用入口？
- Desktop 取消时对 Shim 使用 stdin EOF、进程终止、控制事件还是多种机制？
- 自动差分可以稳定覆盖哪些 Desktop 场景，哪些必须保留为带版本记录的手工 Gate？
