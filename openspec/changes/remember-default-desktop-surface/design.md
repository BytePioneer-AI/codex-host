# Design

## Context

- `crates/launcher/src/launch_preferences.rs` 已保存 `defaultDesktopSurface` 与 `onboardingCompleted`，但缺少独立的记忆授权字段。
- `crates/launcher/src/main.rs` 当前在桌面壳可用时优先进入 `Onboarding`，这是需要保留的默认产品行为；只有用户明确记忆后才应改变。
- `apps/desktop-shell` 的选择页目前每次选择都会写入偏好，托盘已有两个设置入口但不展示有效状态，macOS 与 Windows 可复用同一实现。

## Decisions

### 1. 配置与 CLI 合同

现有版本 1 文件增加字段，不升级版本、不迁移或重写旧选择：

```json
{
  "version": 1,
  "defaultDesktopSurface": "native-shell",
  "onboardingCompleted": true,
  "rememberDefault": true
}
```

- `rememberDefault` 使用 Serde 默认值 `false` 读取旧文件；`launch-prefs get --json` 始终返回该字段。
- `onboardingCompleted` 继续表示用户完成过选择，不参与记忆授权判断。
- `launch-prefs set --surface <...> [--onboarding-completed <bool>] [--remember-default <bool>]` 保持显式 CLI 设置默认入口的旧语义：省略 `--remember-default` 时为 `true`。选择页必须显式传复选框值。
- “每次询问”保留最后选择的 surface，仅将 `rememberDefault` 写为 `false`，避免额外引入空 surface 状态。

### 2. 普通启动路由

- 只有 `rememberDefault=true` 才读取默认 surface：原生壳可用时进入原生窗口，无壳时沿用现有 Web 回退；官方入口仅在检测到安装时启动。
- 默认官方入口缺失且壳可用时进入选择页，让页面展示官方入口不可用；无壳时沿用现有 Web 回退与命令行提示。
- 未记忆、旧配置或未完成引导时保持当前行为：壳可用则显示选择页；无壳则按官方安装情况进入官方客户端或原生/Web 回退。
- 无壳且未安装官方客户端时的自动原生入口继续保存为已记忆，避免无替代入口的环境反复出现无意义选择。

### 3. 双端桌面壳交互

- `chooseSurface(surface, rememberDefault)` 通过同一 Tauri IPC 调用 `launch-prefs set`，成功保存后立即打开所选客户端；托盘在写入后同步，即使随后启动客户端失败也不回滚已确认的配置。
- `getState()` 向选择页返回 `rememberDefault`，首次及旧配置为 `false`，显式重开选择页时反映当前已保存偏好。
- 托盘提供“CodexHost 窗口”“官方 Codex Desktop”“每次询问”三个选项，以勾选文本表示有效状态；官方默认项在未安装时禁用。异步同步采用单调代次，晚到旧结果不得覆盖新选择；后台同步失败不弹阻塞对话框。
- `codexhost app`、`codexhost app --onboarding`、托盘“打开 CodexHost 窗口”均为显式原生窗口行为，不读取默认入口改写目标。普通原生默认重开沿用现有 `Activation::Show`，从选择页进入主窗口；官方默认由 Launcher 直接启动，不额外启动或隐藏原生壳。
- 不照搬历史 Windows 专用 `open_existing_main`，也不引入 `both`、双客户端同时启动或第二套本地配置。

## Risks / Trade-offs

- **旧配置行为变化**：新增字段默认关闭可避免把历史选择变成新授权；显式 CLI 设置仍默认记忆，兼容脚本用途。
- **托盘异步状态竞争**：所有平台共用代次检查，仅在最新读取完成后替换菜单；用户主动设置失败才显示错误。
- **客户端启动失败与配置已保存不同步**：保存与启动是两个结果，托盘反映已保存配置，选择页继续展示启动错误供重试。
