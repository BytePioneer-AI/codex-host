# Spec Delta

## ADDED Requirements

### Requirement: 可选记住默认桌面模式与偏好持久化

系统 SHALL 持久化最近桌面入口、首次引导状态与独立的 `rememberDefault`（Unix 0600）。旧配置缺少该字段时 SHALL 按 `false` 处理；`onboardingCompleted` MUST NOT 作为记忆授权。macOS 与 Windows SHALL 共用配置和路由，只允许一个默认入口。

`rememberDefault=false` 且桌面壳可用时，普通启动 SHALL 显示选择页；为 `true` 时 SHALL 进入保存的可用入口。未安装官方客户端且壳可用时，未记忆启动 SHALL 仍显示选择页；已记忆官方入口但客户端缺失且壳可用时 SHALL 返回选择页。无壳时 SHALL 沿用官方或 Web 回退。显式 `codexhost app [--onboarding]` 与托盘打开原生窗口 SHALL 不受官方默认值影响。

#### Scenario: 未安装官方 Codex Desktop

- **WHEN** 本机不存在可用的官方 Codex Desktop 且 `rememberDefault=false`，用户启动 `codexhost`
- **THEN** 桌面壳可用时显示模式选择页；无桌面壳二进制时自动记忆原生入口并回落本机 Web

#### Scenario: 仅本次打开

- **WHEN** 用户在选择页不勾选记忆选项并选择任一可用桌面入口
- **THEN** 系统保存最近选择但设置 `rememberDefault=false`，立即打开所选客户端，下一次普通启动仍显示选择页

#### Scenario: 记住单一默认入口

- **WHEN** 用户勾选记忆选项并选择自有桌面窗口或官方 Codex Desktop
- **THEN** 系统设置 `rememberDefault=true`，后续普通启动直接进入该入口，不再显示选择页

#### Scenario: 读取旧配置

- **WHEN** 系统读取只有 `defaultDesktopSurface` 与 `onboardingCompleted` 的版本 1 配置
- **THEN** 将 `rememberDefault` 解释为 `false`，不因升级静默改变为直接启动

#### Scenario: 已记忆官方客户端但已卸载

- **WHEN** 已记忆默认模式为官方 Codex Desktop，启动时未找到官方安装且桌面壳可用
- **THEN** 系统显示选择页并将官方入口标为不可用，不打印误导性的原生壳缺失提示或静默卡死

#### Scenario: 显式入口不受默认值劫持

- **WHEN** 用户执行 `codexhost app --onboarding`，或执行 `codexhost app`、从托盘打开 CodexHost 窗口
- **THEN** 分别显示选择页或原生主窗口，不因保存的官方默认入口改变显式命令目标

#### Scenario: 命令行查询与切换偏好

- **WHEN** 用户查询或更新启动偏好命令
- **THEN** 查询返回本机官方安装状态、最近选择、引导状态与 `rememberDefault`；更新合法值后原子写入并在下次启动生效，非法值返回错误

### Requirement: 双端默认入口选择与系统托盘同步

自有桌面壳 SHALL 确保共享 Host 与本地 `web-server` 运行后加载会话界面，并保证单实例聚焦。macOS 与 Windows 的选择页 SHALL 提供相同的“记住此选择，下次直接打开”选项，系统托盘 SHALL 提供打开自有窗口、打开官方 Codex Desktop、默认启动方式、诊断与完全退出等入口。默认启动方式 SHALL 包含自有桌面窗口、官方 Codex Desktop 与每次询问三项，并展示当前有效状态；两个桌面窗口仍可由用户分别打开并共用同一后台状态。

#### Scenario: 双端选择页使用同一记忆交互

- **WHEN** macOS 或 Windows 用户打开选择页
- **THEN** 两端显示相同语义的记忆复选框，其初始值来自当前有效记忆入口；首次、旧配置、官方入口已记忆但未安装时均不勾选，读取状态不修改偏好

#### Scenario: 托盘切换默认入口或每次询问

- **WHEN** 用户从托盘选择自有桌面窗口、官方 Codex Desktop 或每次询问
- **THEN** 系统通过 Launcher 更新同一份偏好并刷新选中状态；每次询问保留最近选择但关闭记忆

#### Scenario: 异步托盘读取乱序

- **WHEN** 较早的偏好读取晚于用户最近一次设置返回
- **THEN** 丢弃较早结果，不用旧状态覆盖最新托盘选择；后台同步失败不弹阻塞对话框，每轮最多首试加两次退避，成功后不再重试，后续窗口入口按需单飞补同步

#### Scenario: 被动恢复选择页

- **WHEN** 选择页隐藏后，用户点击 macOS Dock 或托盘图标
- **THEN** 仅恢复同一引导页可见，不启动 Web、不导航或重载，复选框状态保持不变；Loading/Web 同样仅恢复可见，Dormant 可进入主窗口

#### Scenario: 显式重开已有选择页

- **WHEN** 已记忆自有桌面窗口且现有壳仍显示选择页，用户再次普通启动
- **THEN** 现有壳进入原生主窗口并恢复可见；显式打开原生窗口使用同一路径，不读取官方默认入口
