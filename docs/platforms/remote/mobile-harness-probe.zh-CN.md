# 手机 Remote Control 接入外部 Harness

手机通过官方 Remote Control 连接本机 CodexHost 后，桌面和手机访问同一个外部 Thread，可读取历史、发送消息、接收流式回复、处理标准审批和中断任务。是否支持具体操作仍取决于 Harness 的原生能力。手机 Remote Control 与 Desktop SSH 连接是不同入口。

支持范围为 macOS arm64 与匹配的 Codex CLI 0.160.0。自动验证和实机验证的边界见下文；不同 Harness 的原生能力仍需分别验收。

## 使用条件

首批发行支持 macOS arm64，固定匹配官方 Codex CLI `0.160.0`。显式启用的发行包和 npm 包携带 `app/mobile-codex/`，使用固定上游版本的标准打包流程，包含同一源码构建的 `bin/codex` 和 `bin/codex-code-mode-host`、上游锁定版本的 `codex-path/rg` 与 `codex-resources/zsh/bin/zsh`、`codex-package.json` 安装上下文，以及逐文件摘要、上游 LICENSE/NOTICE、来源和补丁。Host 校验桌面内置 CLI 版本和包内二进制摘要后自动选择该运行时，不修改官方应用内文件。

用户仍通过官方设置开启 Remote Control、登录和配对。安装此功能不会自动开启远程访问，也不会复制认证文件。启动后使用当前 Host 数据目录，无须手工导入会话；更换数据目录会看到不同的会话集合。桌面和手机各自初始化，共享同一个外部会话 owner。

- 桌面创建的外部会话可由手机继续操作，双方看到同一份事件与历史。
- 未提交的预热草稿不进入历史列表；已创建但尚无原生会话标识的空会话不承诺重启恢复。
- 手机断开不会销毁外部 owner。重新连接可读取历史并继续会话。
- 官方后端异常时使用已有恢复机制，外部 owner 独立保留。整个 Host 退出后不承诺运行中的任务继续；已持久化历史通过 Harness 原生会话标识恢复。
- CLI 版本不匹配时保留官方路径并输出诊断；手机外部 Harness 不可用，不尝试跨版本转发。任一必要运行文件缺失、摘要错误或旧清单未声明完整运行文件时，同样保留官方路径，不加载不完整运行时。
- `CODEXHOST_MOBILE_REMOTE=0` 可关闭此接入路径。Windows 原有 Remote Control 路径保持独立，其他平台未加入此发行功能。

升级验收由用户手动正常退出旧桌面后启动一次 CodexHost，让现有会话由新的共享 owner 接管。不要为同一生产数据目录同时启动多个 Host，也不要将隔离测试数据复制覆盖生产数据。

不要将 `npm start` 或关闭桌面的脚本交给 `launchctl submit`、KeepAlive 服务或其他自动重试器。开发入口检测到 Codex Agent 会话标识或命名 launchd 服务时，在任何进程操作前拒绝执行；`--no-build` 先检查开发产物再处理旧桌面。

## 连接与协议边界

固定官方源码的 app-server 只转发由服务端标记为 Remote Control、且通过官方当前认证检查的连接。普通本地客户端继续走官方处理器；Host 回调原生接口使用独立本地连接，避免循环等待。Rust 只负责连接与标准协议转换，TypeScript Host 负责 Harness 和共享会话，插件通过公开契约加载。

Host 自动创建当前用户专属的私有 Unix WebSocket，设置 `CODEXHOST_REMOTE_HOST_SOCKET` 交给子进程；显式传入该变量仅用于受控开发集成。socket 校验目录权限、属主及对端身份。原生进程启动后最多等待 10 秒连接 Host，避免启动先后次序导致偶发失败。认证失效或转发失败会关闭连接，不回退绕过 Host 执行请求。

转发保留官方请求类型、初始化能力和通知过滤。共享通知在当前客户端 initialize 成功后发送；消息上限与固定官方 Remote Control 的 100 MiB 一致，初始化前通知队列单独限制为 1 MiB，超限关闭该客户端。

## 手机模型选择

私有手机连接的 `model/list` 合并官方目录与已安装 Harness 的原生目录。外部条目主标题只显示原生模型标签，Harness 名放在副标题，路由 ID 仅用于协议识别。思考选项逐模型投影；不继承官方模型的服务档位、协作模式或其他未经 Harness 声明的能力。桌面原有模型选择协议保持独立。

手机的模型、思考和服务档位默认值写入 Host 数据目录的 `mobile-model-preferences-v1.json`，不写官方 `config.toml`。手机 `config/read` 返回覆盖值及对应来源、版本；未设置时保留官方配置响应。混合模型与其他配置项的一次写入被拒绝，避免部分保存或误写安全设置。带版本的旧值写入失败后须重新读取。

新建外部会话依据 Harness 路由选择模型，即使客户端发送 `modelProvider=openai` 也不会转成官方会话。已有会话发送时，owner 在同一会话请求队列中执行原生模型和思考选项切换，确认实际状态、保存恢复信息后才开始任务；失败则不发送消息。如果模型已切换而后续思考选项失败，仍保存原生已确认的状态，避免重启后退回旧模型。跨 Harness需新建会话。不支持的服务档位、协作模式及冲突的顶层/嵌套选择明确报错。恢复响应使用 Harness 实际模型重新生成目录 ID。

手机目录是连接级目录，已有会话仍会列出其他 Harness；跨 Harness 选择在发送前明确拒绝，按会话过滤暂未实现。

本实现不自动授予项目信任，也不修改权限模式。手机界面可能保留旧目录或旧默认值，首次升级后需要重新进入连接并选择目录中的模型。自动验证覆盖后端实际状态；手机缓存、名称呈现和真实客户端的选择交互仍需实机验收。

## 构建与验证

`tools/mobile-remote/patches/source.json` 固定官方源码提交、源码归档与补丁 SHA-256。构建重新解压已验证归档并应用补丁；保留独立 Cargo 缓存。补丁包含 Rust 1.98 所需编译递归上限和工作区版本锁定，不升级外部依赖。

```sh
npm run build:typescript
npm run build:mobile-codex
```

开发命令生成 `packages/host-runtime/dist/mobile-codex/`。普通 TypeScript 构建不下载上游 Rust 源码。默认发行流程不构建该实验运行时。使用 `CODEXHOST_BUILD_MOBILE_CODEX=1 npm run release:package -- --target macos-arm64` 或给对应 npm 打包流程设置同一变量，才会构建 release CLI，并在签名后记录最终摘要。构建依赖 Cargo、Python 3.11+、macOS 签名工具及上游依赖缓存或网络。工具执行器还需要 Codex 官方沙箱版 V8；构建复用固定源码内的 `codex_package.v8`，依次校验源码固定的发布清单摘要、V8 静态库和 Rust 绑定文件。

可复现验证入口：

| 入口 | 覆盖范围 |
| --- | --- |
| `tools/mobile-remote/offline-smoke.mjs <CLI> <报告> <官方模型目录 JSON> --cli` | 本地模拟认证与云端，验证列表、历史、流式回复、改名、中断、审批、重连、认证失效和原生回调；外部网络由代理拒绝。 |
| `tools/mobile-remote/production-entry-smoke.mjs <mobile-codex 目录> <官方 CLI> <模型目录 JSON> <报告>` | 实际打包 Host 入口自动选择补丁 CLI，两个客户端共享同一会话，原生回调及退出清理；同时由本地模拟模型驱动真实原生 Thread 执行 code-mode 和嵌套 shell，并在排除用户 PATH 后使用随包 rg，禁止进程内降级。外部 Harness 为明确标识的 Fake。 |
| `tools/mobile-remote/real-model-smoke.mjs opencode\|claude-code <报告>` | 正式手机 facade 下的真实模型切换、短回复、重建隔离 Host 后实际模型恢复；原生 Codex 使用独立临时目录。 |
| `tools/mobile-remote/real-harness-smoke.mjs opencode\|claude-code <报告>` | 真实 Harness，隔离数据目录，跨客户端发现新会话、中断、后续回复和重建 Host 后的历史恢复；使用已有原生 Harness 认证。 |

`production-entry-smoke.mjs` 追加 `--missing-helper` 会只移除隔离副本中的执行器，验收自动保留官方运行时后原生工具仍可执行。

这些工具不安装或重启当前应用。模型目录 JSON 来自固定上游源码 `codex-rs/models-manager/models.json`，命令参数应使用绝对路径。真实测试会调用原生模型，不能宣称离线。

## 正式桌面验收

隔离测试通过后，由用户在独立终端启动一次待验收版本。依次确认：

1. 桌面官方 Codex 会话可以执行工具并得到实际结果。
2. 手机在原有电脑连接中可找到已有 外部 Harness 会话，历史与桌面一致。
3. 手机发送消息，桌面显示同一轮回复；手机中断运行中的任务后，仍可发送下一条消息。
4. 手机模型列表显示可读名称；已有会话切换同 Harness 模型后发送，并新建所选模型会话，核对实际回复与 Host 模型状态。
5. 手机断开重连后可继续同一会话。用户手动正常退出并重新打开桌面后，有原生会话标识的历史仍可读取。

未完成以上检查时，只能标记代码与隔离验收通过，不能标记正式产品已验收。出现工具失效或连接异常即停止切换测试，保留诊断；不得自动反复关闭和重启桌面。

## 隔离手机验收工具

`phone-probe.mjs prepare <CLI>` 创建独立认证目录并固定二进制摘要。用户自行通过官方 CLI 登录后，`start <探针目录>` 使用合成会话，`start-real <探针目录>` 使用已安装原生 Harness，`start-models <探针目录>` 提供合成模型目录。工具不自动登录，不修改项目受信任状态；模型探针通过官方接口将独立目录设置为只读并验证生效。

这些探针要求没有既有配对客户端。输入 `stop` 撤销本次测试配对并退出，模型探针还限制运行时长为 15 分钟；不自动重启。异常退出且清理未确认时，用户应在手机移除测试电脑。认证目录、诊断和真实会话数据不得提交。
