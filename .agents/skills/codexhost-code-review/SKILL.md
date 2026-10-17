---
name: codexhost-code-review
description: 审查 codexhost 的 Pull Request 或本地 diff 的正确性与边界。检查包与 Rust 所有权边界、官方 Thread 与外部 Harness Thread 的区分、Renderer 私有绑定、生命周期与测试强度。用于“review 这个 PR / diff”；一批 PR 的总览与推荐分请先用 codexhost-pr-overview，再对其中需深审的 PR 使用本 skill。
---

# codexhost 代码审查

这是指引，不是完整清单。它是两段式流程的第二段：[codexhost-pr-overview](../codexhost-pr-overview/SKILL.md) 先在表中给出一批 PR 的总览和推荐分，推荐分为 3（需深度审查）的 PR 再由本 skill 审细节。单独审查一个 PR 时可以直接使用。

先读真实 diff 和周边代码，再按下面的检查找出**有证据的缺陷**。一个有证据的阻断项，好过一串风格建议。本 skill 只产出审查意见；评论、approve、合入等对外动作需用户另行授权。

## 先确认范围

1. 确认基线与 head：`git fetch` 后用 `git diff <base>...<head> --stat`；PR 用 `gh pr view` / `gh pr diff`。基线变化后重新确认。
2. 按改动路径归属到包或 crate，读其公共导出、契约和测试，再读 diff。归属见 [AGENTS.md](../../../AGENTS.md) 的 Code Layout。
3. 以 [AGENTS.md](../../../AGENTS.md)、[领域术语表](../../../docs/project/领域术语表.md)、`tools/check-boundaries.mjs`、[docs/index.md](../../../docs/index.md) 中对应功能文档为事实来源。

## 阻断项

1. **边界违规**：Rust 持有了 Host 协议或 Harness 语义；`shared-contracts` 依赖其他包或引入非浏览器安全代码；`renderer-extension` 引入 Node 内置、Electron 私有 API 或 Harness SDK；Harness 专有协议泄漏出对应 Adapter；Host Runtime 直接 import 具体 Adapter 而非走插件公共契约；跨包依赖绕过公共导出。边界检查器只覆盖其中一部分，先读它实际检查什么。
2. **官方流量归属**：Host 只截获自身流量，其余原样转发。检查新增拦截是否有归属依据，参见 [official-traffic-ownership](../../../docs/architecture/official-traffic-ownership.md)。
3. **概念混淆**：官方 Codex Thread 与外部 Harness Thread；本地与远程 Host；Native Session 事实与 Host 元数据；Harness、Model、Provider、Account、Billing Source；能力（capability）与 UI 入口。
4. **文档与实现一致**：改动核心逻辑或契约时，对应 `docs/` 功能文档、`docs/index.md` 链接已同步；没有把变更报告当功能文档写。
5. **证据真实**：作者声称“已测试”的检查确实对应改动；没有执行的检查不得写成通过。

## 人工检查

- **接口两侧**：追踪每个被改接口的调用方和实现方，核对错误、取消、所有权与释放。
- **生命周期与并发**：异步初始化、回调、子进程、会话、CDP 连接的发布前竞态、await 期间取消、重复输入、过期结果、重连与恢复、完整清理。
- **能力与消费者匹配**：通用接口里只服务单一调用方的新增方法，应改为在构造时交给该调用方的私有闭包；调用方私有行为不应泄漏进公共接口。
- **范围与必要性**：每个新增抽象、状态、选项、兼容路径，是否对应当前契约和生产使用者；与 [AGENTS.md](../../../AGENTS.md) 的 Implementation Principles 对照。
- **Renderer 绑定**：对 Codex Desktop 私有 DOM / React 状态的依赖是否版本化、能在版本不匹配时安全降级；新绑定是否有 `tests/e2e` 或探测覆盖。
- **强制执行路径**：沿每条拒绝或校验路径追到真正执行的操作，检查有无绕过的替代入口。
- **持久化与兼容**：触及 `mapping-store`、插件清单、配置格式时，旧数据如何读取。
- **测试强度**：断言是否会在目标回归出现时失败，是否验证外部状态、事件或释放，而不是复述实现；是否走了真实入口（真实 Loader、插件加载、worker、子进程），而不是手工拼装。
- **平台**：文件系统、路径、进程、环境变量相关改动，是否考虑 macOS / Windows / Linux（CI 的二级平台只跑平台敏感测试）。

## 报告

每条意见写明：缺陷、位置、影响、证据。局部缺陷标到最小 diff 范围；跨模块的架构或范围问题单独列出。区分“阻断”和“建议”，不重复已被绿色 CI 门禁覆盖的问题。收到审查意见时，逐条核实后修复或有技术依据地反驳，不做表演式附和。
