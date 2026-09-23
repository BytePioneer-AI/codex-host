## Context

工作树 `codex-host-dsh-017rc1` 以 `23a6f5e9` 为基线。Adapter 当前按 `0.1.2` → V0、其他 SemVer → V3 选择 profile，再严格校验 Web Remote 与日志；文档已将 `0.1.5-rc.2` 列为真实 CLI 验证版本，但主 OpenSpec 仍残留早期精确双版本规格。DSH tag `dsh-v0.1.5-rc.3`（`a4c74a91`）的 Session 写入器是 V3；与 rc.2 比较，所检查的 API/Session/命令源码无改动。`dsh-v0.1.7-rc.1`（`46a7f68b`）的写入器是 V4，新增 `developer/message`、Fork 终止原因及 Remote 历史/控制字段变化。源码观察仍需由精确版本真实 CLI Gate 验证。

变更链路是：连接页提示 → Host `harness/inspect` → DSH Adapter 的 CLI 探测与托管 Web → 原生 Remote/Session → Adapter 历史及实时投影 → 公共 Harness 输出。原生 Session 和凭据归 DSH；Host 只持有映射与标准输出。V4 的差异须留在 Adapter，不让 DSH wire 类型进入 Host 或 Renderer。

## Goals / Non-Goals

**Goals:** 证明并交付 `0.1.5-rc.3` 与 `0.1.7-rc.1` 的本机托管 Web 对接；保留已验证的旧版本行为；使 OpenSpec、代码、测试、版本提示和验证记录一致；向 upstream `main` 提交可审阅的中文 PR。

**Non-Goals:** 移植 DSH 新 UI、浏览器/计算机操作、全部 0.1.7 产品功能，或把 DSH 原生 Session 迁移逻辑复制进 codexhost；不升级其他 Harness 或重构公共包。

## Decisions

1. **先固定证据，再定 profile。** 对照两个 tag 的 Remote endpoint、认证、Session 列表、模型/权限/命令、日志、Assistant 流、Fork/队列、关闭与 flush，记录字段矩阵。rc.3 仅在真实 Web 与生命周期 Gate 通过后列为已验证；V4 为 `0.1.7-rc.1` 选择独立 profile。保留其他 SemVer 版本尝试原生协议校验的现行策略，未知版本不获得已验证声明。备选的“放开版本号即可支持”会将 V4 错交给 V3 校验，因此不采用。
2. **按原生格式隔离恢复。** V0/V3 路径保持现有行为；V4 在 Adapter 内校验 header、事件、surface 引用、Assistant baseline/settlement、控制投影。对 `developer/message`、新 Fork closers、错误详情及其他已知事件按标签源码制定投影或明确忽略规则；未知 required 事件失败，原生标为 ignorable 的事件仅按其允许的语义处理。备选的宽松解析会使错误历史看似可恢复，因此不采用。
3. **原生确认决定 mutation 成败。** 创建、恢复、显式导入、连续回合、取消、权限、Fork、最后回合回滚、队列清理和关闭沿用现有 Adapter 操作入口；V4 checkpoint 使用独立格式标记及精确版本 locator，跨格式或迁移后的旧序号不得用于 Fork/回滚。只有原生前缀、marker/closer、控制状态和持久化结果可确认时才接纳新子 Session。备选的直接复用 V3 checkpoint 会误把迁移后的 seq 当作同一切点，因此不采用。
4. **最小改动所有权。** 先改 `packages/adapters/deepseek-harness` 和测试；连接页仅更新已验证版本文案与推荐安装版本。Host/`shared-contracts` 仅在确实无法表达原生能力时改，保持公共插件契约与发布清单边界。使用现有 `tools/gate-dsh/lifecycle.real.test.mjs`、`test:deepseek:coverage` 和 Vitest；真实 Gate 如因 017 原生模型 API 变化而失败，先区分测试模型桩和 Adapter 故障，再作必要修正。
5. **OpenSpec 先于实现。** 本 change 的 proposal/design/delta specs/tasks 经 strict 校验后开始 apply；实现阶段据标签源码细化字段与场景，同步受影响主规格和 DSH 文档。历史 archive 作为旧决策证据保留，不在规划阶段改写。

## Risks / Trade-offs

- **V4 原生迁移重编号或改写旧历史** → 冷恢复可读取经 DSH 迁移的 Session，但旧格式 checkpoint 必须失效；验证导入、恢复与 rollback 的边界，不由 CH 修改 JSONL。
- **017 Remote schema 与认证/控制语义变化** → 定向对比 endpoint 与返回结构，再用真实 CLI Gate 验证，协议不符明确报错，不凭版本号报 ready。
- **Fork 尾部与未完成回合变化** → 分别验证完整回合、开放回合、继承待办及重连；子 Session 未确认时不接纳，也不影响源 Session。
- **npm 子包混装或 Web profile 启动失败** → 隔离安装/构建精确 tag 与临时 `DSH_HOME`，记录实际依赖和启动错误；`--version` 成功不算对接证据。
- **平台和模型覆盖有限** → Windows 上用本地模拟模型与真实 DSH CLI 做生命周期 Gate；PR 明确其他平台、真实计费模型和 Desktop 交互的未验证范围。不使用浏览器自动化或 computer use。

## Migration Plan

先提交规划和协议证据，再实现与验证；只有通过相应版本的真实 Gate 才把它写进“已验证”列表。发布后使用 DSH 自身提供的 V3→V4 迁移；本变更不自动升级用户 CLI 或降级原生数据。回退 codexhost 时，较旧 Adapter 不保证读取已迁移至 V4 的会话；不得把 V4 旧 checkpoint 当 V3 使用。

## Open Questions

- 017 的认证、Session 列表、模型/权限目录、控制流、命令和 export flush 是否维持本机部署下的原生契约，需按 tag 源码与真实 Gate 逐项确认。
- 017 的已知新事件和 Fork synthetic closers 中哪些影响 Host 可见输出，需在协议矩阵中逐项标注和测试。
- 新推荐安装版本以两版精确安装及生命周期 Gate 的实际结果决定；未通过时保持当前推荐版本并如实说明阻塞。
