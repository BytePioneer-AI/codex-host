# Proposal

## Why

桌面壳当前在 macOS 与 Windows 上每次普通启动都显示打开方式选择页，即使用户已经反复选择同一个入口。选择结果虽已持久化，但配置没有区分“完成过选择”和“明确希望记住默认入口”，因此不能直接恢复旧路由，否则会把历史选择静默转换成新的启动行为。

## What Changes

- 在现有 `launch-preferences-v1.json` 中增加可选 `rememberDefault`，旧配置缺少该字段时按 `false` 处理；`onboardingCompleted` 只记录选择历史，不再被解释为记忆授权。
- macOS 与 Windows 使用同一选择页交互：用户可勾选“记住此选择，下次直接打开”；未勾选时仅打开本次所选客户端，下次普通启动仍显示选择页。
- 普通启动仅在 `rememberDefault=true` 时进入保存的单一默认入口；默认官方 Codex Desktop 已卸载但桌面壳可用时回到选择页，不显示误导性的缺失提示。
- 系统托盘在双端提供 CodexHost 窗口、官方 Codex Desktop、每次询问三种状态，并同步当前有效默认值；显式 `codexhost app --onboarding` 始终打开选择页，显式打开原生窗口不受默认入口影响。

## Decisions

- **显式选择记忆，不从历史选择推断授权**：避免升级后改变既有用户的启动行为。
- **双端同一配置与交互合同**：不保留 Windows 专用路由、托盘或回退分支。
- **只支持单一默认入口**：不引入 `both` 或一次启动多个客户端的模式；两个客户端仍可由用户分别打开并共享 Host。
- **Launcher 继续拥有持久化与路由**：桌面壳通过现有 `launch-prefs` CLI 读写，不建立第二份配置状态。

## Capabilities

### Modified Capabilities

- `unified-desktop-entrypoints`: 将一次性默认选择调整为可选记忆，并统一双端选择页、托盘和单实例重开行为。

## Impact

涉及 `crates/launcher` 的配置兼容、CLI 与默认路由，以及 `apps/desktop-shell` 的选择页、壳桥接、托盘和激活行为。不修改 Host 协议、Harness、Mapping Store、官方 Codex 流量归属或发布链路。
