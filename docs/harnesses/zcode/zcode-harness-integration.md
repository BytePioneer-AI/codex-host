# ZCode 本地服务 Adapter

插件 ID 为 `zcode`，使用 ZCode 3.14.3 的原生 Services 与同源 Agent CLI 执行独立会话，复用同机登录账号。不依赖 Desktop 窗口、官方远控 Relay 或配对链接。

Adapter 拥有每个 Session 的本地后端进程和 Host 事件投影；原生 ZCode Services 拥有账号权益、请求认证、Agent 进程和会话持久化。Host 仍通过公共 Loader、Adapter/Session 契约、共享 Harness 路由及 Mapping Store 管理任务。原生凭据不进入 Host 配置、Native Ref 或 Renderer。

首版只创建和恢复 codexhost 自己的会话，不提供已有 Desktop 会话导入。每个活动 Session 使用独立后端，以保证 Thread 环境覆盖传到实际工具进程。临时 inspect 后端只读取经过白名单投影的目录，不创建用户会话，不发送 Prompt。

## 运行包与安装

运行包固定为 `zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e`，包含 Services、Agent CLI 0.16.9、内置 Provider 配置、依赖与许可声明。它独立于插件，不从已安装 Desktop 的私有 chunk 加载代码。需要 Node 24；不同运行平台应分别构建和验证运行包。

在 ZCode Desktop 中完成登录并选择账号/套餐。原生 Services 使用同一用户数据根；设置了 `ZCODE_DATA_BASE_DIR` 或 `ZCODE_CREDENTIAL_SECRET` 时，须与登录环境一致。不复制 token 到 codexhost。

准备精确源码快照，并按其 README 安装构建工具。以下命令要求 Node 24 和 pnpm 10.33.2 在 PATH 中，`<source>` 指该源码目录：

```sh
pnpm --dir <source> --filter @zcode/server... --filter @zcode/cli... install --frozen-lockfile --ignore-scripts --config.node-linker=isolated
ZCODE_ENV=production pnpm --dir <source> --filter @zcode/cli... build
ZCODE_ENV=production node <source>/apps/zcode-cli/packages/cli/scripts/build.mjs --desktop-agent
node tools/zcode-runtime/build.mjs --source <source> --output <new-runtime-directory>
```

最后一条从 codexhost 仓库根运行。构建器拒绝不同提交、已修改源码及已经存在的输出目录。它保留 ZCode 与第三方许可，并生成 `CODEXHOST-MODIFICATIONS.md` 说明局部改动。

默认安装目录为 `${CODEXHOST_DATA_DIR || ~/.codexhost}/runtimes/zcode/3.14.3`，也可用 `CODEXHOST_ZCODE_RUNTIME_DIR`，或在连接设置中保存运行包目录。设置的安装路径指**包含 runtime.json 的运行包目录**，不是 ZCode.app。保存的启动路径优先于环境变量；检查安装不会自动下载、构建或修补应用。

## 会话与账号验证

创建和输入统一使用原生 V4 命令，避免将旧式立即持久化创建与 V4 admission 混用。 固定源码快照的 CLI 会发出 `turn.started.executionStartedAt`，但 Services 的严格事件 schema 漏了此字段；运行包构建时补上该已知数值字段，保留严格校验，避免整条开始事件及其持久消息 ID 被丢弃。Host 仍要求成功 Turn 携带真实 Native Turn 身份，不用历史最后一条消息猜测身份。Model、Thinking、Permission 的 effective 值必须经原生快照确认。省略 Model 时由原生选择；主动选择 Model 所需的默认 Thinking 从原生 `completeNewModelSelection` 取得，不在 Host 猜测。原生模式/偏好是否持久化遵循 ZCode 自身语义。

Start Plan 请求可能要求 CAPTCHA。用户已确认接受必要时手动验证。运行包对固定源码作三处窄扩展：公开配置只增加 CAPTCHA 的 scene/region/prefix；Services 装配接受逐请求验证回调；原生请求取消通过 AbortSignal 中止验证。账号 JWT、权益与请求身份继续由原生服务处理，回调只返回两项官方验证码 Header。

验证在 Codex 内置浏览器的后台标签页中运行，优先调用官方 SDK 的无感验证。SDK 要求交互或无感阶段未完成时才显示面板，由用户完成挑战。加载失败直接结束请求，不把网络错误伪装成需要人工验证。页面只监听 `127.0.0.1`，使用根地址的随机 `token` 查询参数与同源提交校验；结果只交给对应请求，不缓存、复用或写入历史/日志。

公共插件上下文提供本地页面的 `show/close` 句柄，Host 只装配该通用能力。Desktop Controller 通过既有认证控制连接管理页面，使用原生后台标签页、显示和关闭消息；不修改主聊天页 CSP，也不打开外部浏览器。页面绑定创建时可见的本地任务；需要人工处理时会切回该任务显示面板。没有可见任务或内置浏览器不能加载时明确失败，受管远程 Host 不提供此能力。

成功、取消、150 秒总等待到期、Session 关闭或控制连接断开会关闭所属页。用户关闭页面会取消对应验证；验证结束后到达的显示事件不得再打开面板。150 秒是 Adapter 的等待上限，不代表官方证明有效期。

## 能力与限制

- 支持独立创建、多轮、取消后继续、可写恢复、只读历史、Model/Thinking/权限选择、工具输出、原生文件差异、Approval/Question 与 Usage。
- 接入公共 Loader、共享 Harness route、Desktop Picker/状态恢复和普通委派通道。每个 Session 的环境到达实际工具进程；真实递归委派没有在本次执行，不能仅凭环境测试称为完整协调验收。
- 首版不导入 Desktop 已有会话，不开放 Fork、修订上一条消息或子代理 Transcript。子代理状态与自主 Turn 按原生事件投影；完整后台子代理/Goal 场景尚未逐项实机验收。
- 空 V4 草稿由原生以 deferred 语义持有，首条发送才持久化；尚未发送的草稿关闭后不能承诺恢复。不会制造新会话冒充旧身份。
- 未接管 Desktop 的浏览器、Computer Use、账号切换和额度展示 UI。该源码快照的原生账号配置仍可能自行刷新；启动 Agent 必须使用 Services 注入的 active 配置路径，不能覆盖成 bundle 配置。

## 验证

运行常规聚焦测试前按根 package scripts 构建。原生验证使用本地模拟 Provider 与隔离数据根，启用方式：

```sh
CODEXHOST_TEST_ZCODE_RUNTIME=<runtime-directory> npx vitest run --config tests/vitest.config.js packages/adapters/zcode/test/native.test.ts packages/host-runtime/test/app-server-host.zcode.real.test.ts
```

2026-09-26 在 macOS arm64 / Node 24 验证了目录、多轮/恢复、取消后继续、并行工作区工具环境、原生提问、审批、配置和文件差异；真实 Loader → Host 路由 → 原生 Turn → 历史路径另有集成测试。验证码边界测试使用合成证明，不能替代真实验证。 Host 集成测试直接断言实时 `turn/completed` 成功，且在任何历史读取前检查 Native Turn 映射已保存；历史回读不得新增或替换这一映射，以免掩盖实时身份丢失。

同日真实 Z.ai Start Plan / GLM-5.3-Flash 在用户手动验证后返回 `ZCODE_ADAPTER_OK`，关闭后恢复了同一 Session。Desktop 选择与共享 route 通过浏览器测试。随后本机 Codex 内置浏览器中的真实 Start Plan 测试完成了无感回复、工具文件写读和同一 Session 恢复，观察到四次后台验证、零次显示面板；这证明本次环境正常路径可无感通过，不保证所有后续风控请求都免人工。人工挑战、延迟 success、加载失败与取消分支另有使用合成 SDK 的浏览器测试。日常进程需要重新加载更新后的 Host、Controller、Renderer 和运行包。Windows、Linux 和 SSH 未做本次原生验收。
