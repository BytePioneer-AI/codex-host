## Why

codexhost 已验证的 DSH 版本止于 `0.1.5-rc.2`，而当前 Adapter 将所有非 `0.1.2` 的 SemVer CLI 都交给 V3 profile。`0.1.5-rc.3` 仍写入 V3；`0.1.7-rc.1` 已改用 V4 并调整原生事件与 Session Remote，现有尝试连接策略不足以证明两版可用。主 OpenSpec 仍记载早期“双版本白名单”，也与当前实现不符。

## What Changes

- 用两个固定 release tag 的源码和隔离真实 CLI 验证，明确新增版本的连接、创建、回合、恢复、导入、Fork、回滚和关闭边界。
- 为 V4 增加 Adapter 内的原生格式处理；`0.1.5-rc.3` 复用 V3 的前提须由源码差异和真实生命周期 Gate 证明。
- 修正主规格中已过期的精确双版本声明，保留“SemVer 探测、按格式尝试、原生协议严格校验”和“已验证版本单独列示”的现行策略。
- 更新连接页的已验证版本提示、DSH 专项文档和验证记录；只在实测通过后将版本标为已验证。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deepseek-versioned-web-protocol`: 扩充 V3/V4 格式、版本探测、恢复边界与验证声明。
- `deepseek-harness-fast-session`: 公共 Adapter 对新原生版本的承诺以协议验证为条件。
- `local-deepseek-harness-session`: 托管 Web 和历史读取接受经验证的 V4 会话，维持本机原生数据所有权。

## Impact

主要涉及 `packages/adapters/deepseek-harness` 的 profile、Remote 校验、历史/控制/恢复与定向测试，以及真实 CLI Gate。只有现有连接文案确需更新时才改 `packages/renderer-extension`；仅在公共契约确有缺口时调整 Host 或 `shared-contracts`。同步 `docs/harnesses/deepseek/`、受影响的架构文档和 OpenSpec 主规格。参考 DSH 仓库只用于读取与隔离验证，不纳入 PR，不改写用户原生 Session 数据。
