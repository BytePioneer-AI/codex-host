## Why

codexhost 已验证的 DSH 止于 `0.1.7-rc.2`，但 npm 上 `@deepseek-ai/dsh` 的 `latest` 与 `next` 均已是 `0.2.0-rc.2`：连接页“更新 CLI”会把用户升到未验证版本，而安装指引仍固定安装 V3 的 `0.1.5-rc.1`。`0.2.0-rc.1`/`rc.2` 仍写 Session Format V4，但有两处实际缺口：

- DSH 给没有结果的工具调用补写合成 `tool/result`。`0.1.7` 起崩溃恢复就会写 `interrupted-tool-result-*`，`0.2.0-rc.1` 起运行中失败的 step（包括用户取消时尚未启动的工具调用）也会实时写入。当前 V4 校验只接受 Fork 生成的 `forked-tool-result-*`，实时投影也不认识未启动的调用，两处都会判为协议错误并使 Session 故障。
- `0.2.0-rc.2` 的限时提问（preset 设 `mode: timed`）会在请求中附带 `wait`，当前解析直接拒绝并使 Session 故障；即使放行，DSH 到期后模型继续工作而问题仍可回答，codexhost 却会把 Desktop 上的提问关掉，用户无法再回答。

另外，未合并的 PR #412 修复了 V4 的两处问题：PTC 子调用被折叠进一张 `run_code` 卡片，以及 V4 无法选择权限模式。0.2.0 的相关源码与 0.1.7-rc.2 相同，这两处同样影响 0.2.0，所以一并纳入。

同时 Adapter 维护 V0/V3/V4 三套 profile：约 95 处按格式分支，V0 还是多个函数的默认 profile，漏传 profile 会静默按 V0 校验。DSH 0.2 自带 V0→V4 的原生迁移，codexhost 不再需要读取旧格式。

## What Changes

- 新增 `0.2.0-rc.1`、`0.2.0-rc.2` 对接：按固定 tag 审计协议差异，修复合成工具结果的校验与实时投影；真实 CLI 生命周期 Gate 通过后才列为已验证。
- 限时提问支持同一回合内的迟到回答：接受 `wait`；DSH 到期释放等待后，只要同一 Host 回合仍在进行，Desktop 上的提问保持可答，用户回答经原生 `userQuestions/answer` 送达；回合结束前关闭。不做倒计时，不做跨回合回答。
- 纳入 PR #412（保留原作者提交）：V4 的 PTC 子调用各自投影为 Tool Item 并隐藏 `run_code`；V4 权限模式读取进程级 `permissionPresets/catalog`。
- **BREAKING** 移除 V0（`0.1.2` 系列）与 V3（低于 `0.1.7-rc.1` 的其他版本）的 profile、格式分支与测试，包括 #412 为 V0/V3 保留的分支。最低支持版本定为 `0.1.7-rc.1`（首个 V4 版本）；低于它的 `--version` 在启动 Web 前以 `unsupported` 明确失败并提示升级。
- 将 V3/V4 profile 合并为单一 V4 profile。旧 Thread 引用保持可恢复：无 locator 的旧引用和 V3 时期的 locator 在 DSH 自行迁移后仍可打开；Fork/回滚 checkpoint 继续要求 `v4-turn-end:` 与精确版本 locator。
- 连接页已验证版本改为 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`，推荐安装版本改为 Gate 通过的最新版本；验证记录改名为 `docs/harnesses/deepseek/dsh-version-validation.md` 并随本变更更新；同步 DSH 文档与主规格。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deepseek-versioned-web-protocol`: 版本选择收敛为“最低版本门槛 + 单一 V4 格式”；V4 在历史与实时中接受 DSH 恢复产生的合成工具结果；PTC 子调用投影只按 V4 定义；删除 V0/V3 场景。
- `deepseek-harness-fast-session`: 已验证版本改为 V4 系列，低于门槛的运行时明确失败。
- `local-deepseek-harness-session`: 托管 Web 启动前拒绝过旧 CLI；历史只按 V4 读取；权限模式只从 V4 catalog 发现；限时提问支持同一回合内的迟到回答。
- `harness-permission-mode-control`: DeepSeek 的权限模式目录只来自 V4 `permissionPresets/catalog`。

## Impact

- `packages/adapters/deepseek-harness`：删除 `profiles/v012.ts`，合并 `profiles/v015.ts` 与 `profiles/v017.ts` 为 `profiles/v4.ts`，简化 `profile.ts`、`generation-selector.ts` 及 `modern/*` 的格式分支；`event-gateway.ts` 与 `session.ts` 增加限时提问的 continued 状态与迟到回答；`history.ts`/`session.ts` 处理未启动调用的合成结果。
- `packages/renderer-extension`：连接页支持版本文案（中英）、DSH 安装指引固定版本及对应测试。
- 文档：验证记录改名重写，`docs/harnesses/deepseek/` 其他文档、`docs/architecture/` 中 5 篇提及版本的文档、`docs/index.md` 描述和 OpenSpec 主规格。
- 不改 Host、`shared-contracts` 或公共插件契约；`unsupported` 是现有 `HarnessErrorCode`，`expired`/`superseded` 是现有 `interaction.closed` 原因。
- 用户影响：仍在 `0.1.2`/`0.1.5` 的用户升级前无法连接（本机当前全局安装的即为 `0.1.5-rc.2`）；升级后旧 Session 由 DSH 迁移，旧 checkpoint 不能再用于 Fork/回滚（现行行为已如此）。

## 当前实证状态

- 基线：在与 upstream main `94e795f8` 完全一致的新工作树中执行 `npm ci`、`npm run build:typescript` 后，DSH Adapter 测试 24 个文件、865 个用例全部通过。旧目录中出现的 6 个失败来自拉取上游后未重新构建的 `dist`，与本变更无关。
- 纳入 #412 的 5 个提交后，DSH Adapter 测试 25 个文件、891 个用例全部通过。
- 固定 tag 源码审计已完成（`dsh-v0.1.7-rc.2`、`dsh-v0.2.0-rc.1`、`dsh-v0.2.0-rc.2`），结论见 design。
- 四个目标版本的真实 CLI 生命周期 Gate 均已通过，崩溃恢复、限时提问、权限与 Fork、旧会话迁移和过旧版本拒绝另有真实 CLI 探测，见 `docs/harnesses/deepseek/dsh-version-validation.md`。Desktop 手测由用户完成后 PR 再转为 ready。
