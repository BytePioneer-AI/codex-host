# 连接页：展示、安装、版本更新、启动路径

对应能力总表：C1–C5。Desktop 的「设置 → 连接」完全由插件目录和这些可选能力驱动，不需要改 Renderer。权威来源：`packages/shared-contracts/src/harness-plugins.ts`（Manifest）、`harness-installation.ts`（版本状态）、`harness-presentation.ts`（本地化）；`packages/harness-discovery/src/`（安装器与版本工具）；行为说明见 `docs/architecture/harness-plugin-runtime.md` 的「Harness CLI 版本与更新」「首次安装」「自定义启动路径设置」「插件拥有的展示元数据」，以及 `docs/architecture/harness-executable-discovery.md`。

## Manifest 展示字段

| 字段 | 规范 |
|---|---|
| `name`、`version` | 必填；`version` 是插件版本，与原生 CLI 版本、`adapterApiVersion` 无关 |
| `icon` | 插件内的相对路径；只接受 PNG、JPEG、WebP 或受限的 SVG（不能有脚本或事件属性），最大 128 KiB；Host 转成 data URL，用 `img` 渲染 |
| `iconStyle` | `vector`（受限的 viewBox、颜色和 path，最多 32 条）或 `background`、`borderRadius`、`paddingRatio`；**不接受**任意 CSS 或 SVG 文本 |
| `links` | `website`、`documentation`、`installation`；只能是不含凭据的 HTTPS 链接 |
| `installation` | `commands[]`（`terminal` + `command`，最多 8 条，**只展示给用户复制，从不执行**）、`before` / `after`（`{ en, "zh-CN"? }`）、`downloads[]`（桌面应用类 Harness 用它提供下载按钮） |
| `notice` | `{ en, "zh-CN"? }`，插件自有的提示 |
| `launchCommand: true` | 见下文的自定义启动路径 |

权限模式的文案通过 `localizations: { [locale]: { label?, description? } }` 提供，由公共函数 `localizeHarnessPresentation` 按字段回退。localizations 不能覆盖 ID、危险标记或执行行为。

验收：Manifest 通过 schema 校验；图标能在浅色和深色主题下正常显示；中文和英文都有文案。

## 版本检查与更新

接口：`adapter.installation?(action: "check" | "update"): Promise<HarnessInstallationState>`。通常在工厂里挂到 Adapter 上（参考 Pi 和 Kimi 的 `plugin.ts`：`Object.assign(new XAdapter(...), { installation, install })`）。

返回 `HarnessInstallationState`：

- `currentVersion`、`latestVersion`、`updateAvailable`、`canUpdate`：必填。
- 无法安全查到最新版本时，`latestVersion` 填 `"Unknown"` 并设置 `latestVersionKind: "unknown"`；按 Git 分支跟踪时设置 `latestVersionKind: "tracking-branch"`。不能假装与已安装版本一致。
- `versionKind: "application"`：CLI 随桌面应用分发时使用（参考 WorkBuddy）。
- `manualUpdateUrl`：官方安装包链接（不含凭据的 HTTPS）。提供后，界面显示「下载更新」，不会自动更新。
- `notice`：面向用户的本地化说明；`message` 只是诊断文本，界面不会原样展示。

必须：

- check **不发起**模型 Turn，也不安装任何东西；只有用户明确点击时才执行 update。
- 版本来源、安装渠道识别、原生更新命令都由 Adapter 决定。无法确认当前安装渠道（自定义路径、包管理器、Nix 等）时，返回 `canUpdate: false` 和手动更新说明，不能更新另一份安装。
- 并发的更新合并为一次；检查不能与更新后的版本回读竞争；更新后版本没有变化，不能报告成功。直接使用 `createInstallationManager({ check, update })` 即可满足这些要求。
- 超时：普通命令 30 秒，更新命令最多 5 分钟，读取最新版本的网络请求 15 秒（`fetchInstallationText`）。
- 版本比较用 `newerInstallationVersion` / `versionFromOutput`：区分预发布标识，不降级更新的安装。
- npm 安装用 `npmInstallation`，只在准确的 npm prefix 中更新。
- 不更新 Host 插件或 codexhost 本身，也不重启已有的 Session。

验收：已是最新、有更新、未知最新版本、只能手动更新、更新失败、更新后版本不变这几种情况；并发点击只执行一次更新。

## 首次安装

接口：`adapter.install?(): Promise<void>`。Host 先刷新检查，只有状态为 `notInstalled` 时才调用；装完后用 `installation("check")` 回读版本。

- 用 `createHarnessInstaller(environment, source)` 创建安装器。`source` 只能由 Adapter 固定，不能来自 RPC：
  - `{ npm: "<package>", allowScripts? }`：官方 npm 包（DSH、OpenCode、Grok、CodeBuddy）。
  - `{ posix: "<https sh>", windows: "<https ps1>", shell? }`：官方安装脚本（Pi、Claude Code、OMP、Antigravity、Kiro、Cursor、Hermes、Qoder、Kimi）。
- 安装命令最多运行 10 分钟；不自动提权，不安装系统依赖，安装器不能依赖交互输入。
- 原生只以桌面应用形式分发时（WorkBuddy、ZCode），不提供 `install()`，改用 Manifest 的 `installation.downloads` 引导用户下载。

验收：安装成功后版本回读正确；安装失败时错误信息已脱敏；已安装但未登录的情况不会触发安装。

## 可执行文件发现

接口：`@codexhost/harness-discovery` 的 `resolveHarnessExecutable` / `HarnessDiscoverySpec`、`commandInvocation`、`withNodeRuntimeOnPath`。

- 插件声明命令名、专用的环境变量（约定为 `CODEXHOST_<NAME>_COMMAND`）和安装目录；PATH 搜索、平台扩展名、版本管理器目录、Windows shim 和 Node PATH 补充都由公共包处理。
- 用户显式配置了一套安装后，不能静默回退到另一套。
- 同一份实现服务多个变体时，各变体分别解析自己的命令和环境变量（参考 qoder / qoder-cn）。

## 自定义启动路径

适用场景：原生 CLI 随桌面应用安装，路径不在 PATH 中（参考 WorkBuddy、ZCode）。

- 在 Manifest 中声明 `launchCommand: true`。连接页会为本地 Host 提供路径的输入、保存和清除。
- Host 把保存的路径持久化到 `${CODEXHOST_DATA_DIR}/harness-launch-settings/<id>.json`，下次构造插件时通过 `context.launchCommand` 传入。
- 工厂把它映射到原生的启动配置，优先级高于继承的环境变量；清除设置后，回到环境变量或自动发现。
- 用户填写的是应用安装目录，不要求定位到可执行文件或脚本。目录布局不完整时，检查要失败，不能借用其他安装的文件，也不能回退到 PATH。
- 修改后需要重启 codexhost 才生效，Adapter 不需要热替换。

验收：设置、清除、目录无效三种情况；设置后优先于环境变量。
