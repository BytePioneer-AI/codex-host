# Tasks

## 1. Windows 安装身份与准备

- [ ] 1.1 在 `packages/update-manager` 的现有安装解析与公共接口中补齐 Windows 归属验证：npm 从运行的 CLI 入口及平台包真实路径验证全局 prefix、包名、架构与版本，拒绝链接/越界/不明确布局；安装包固定当前根目录。保留公共协调及 npm/Windows 安装包/macOS App 执行分支，不复制 Windows npm 更新流程。复用现有请求，仅为必需信息补充字段并按实际兼容需要处理 schema，不预设独立 Windows 协议。验证：`distribution.test.ts`、`request.rs` 覆盖多 prefix、嵌套/提升的平台包、版本不符、链接、大小写及中文空格路径；macOS/Linux 既有行为保持不变。

- [x] 1.2 为 Windows npm 补退出前预下载，复用可信 npm CLI 的包获取、完整性校验和离线能力，确认精确 CLI、匹配平台包及必需安装材料齐全；正式安装使用明确 prefix 和已准备材料，不联网补包或回退浮动版本。不将隔离试装设为每次生产更新的必经步骤；若材料完整性仍无法确认，先报告具体缺口。保留 EXE 大小/SHA-256 校验，准备阶段不写当前安装。验证：在测试用隔离 prefix 禁网执行真实 npm 安装，并覆盖缺包、摘要不符、准备超时与磁盘写失败；确认 macOS npm 原行为不变。同步控制台更新文档中的准备时机。

## 2. 交接与进程所有权

- [ ] 2.1 修复 `crates/launcher/src/active_update.rs` 的 Windows helper `.exe` 路径，复用现有就绪握手与操作锁，在 Host/控制台/终端入口保证临时 Updater 确认接管后才退出旧所有者。锁转移和释放校验同一操作，结合 PID 与创建时间防复用；活 Updater 不因旧 Host 退出而被清锁。死 Updater 的安装/恢复未完成状态应报告需修复，不直接清锁后继续覆盖；未写安装的准备失败可正常重试，不引入完整事务日志。验证：Launcher、`updater-ready.test.ts`、`operation-state.test.ts`、入口协调测试覆盖交接失败、重复点击、PID 复用、旧所有者退出及异常中断；保持 macOS 启动责任不变。

- [ ] 2.2 复用 PR #640 的 Windows 目标安装关闭能力，在 apply 前显式确认其已合并或作为依赖纳入独立实现分支，不混入当前工作区的其他改动。覆盖 Desktop 自有树和独立控制台退出；npm 的共享系统 Node 只能通过已验证的进程身份和该安装入口归属来定位，禁止按 `node.exe` 名称或共享路径关闭。只在交接完成后停止进程，文件占用采取有界重试。验证：Windows 原生进程测试覆盖自有/其他安装控制台、相同 Node 的无关进程、退出中的 PID、持续占用；普通 Inno 界面打开/取消不关闭进程，点击安装才关闭，界面不增加提示。

## 3. 可恢复安装与启动确认

- [ ] 3.1 在现有 `crates/updater` 分渠道执行中补 Windows 安装与有界失败恢复：EXE 显式 `/DIR`，npm 显式原 prefix；退出前检查权限/空间、验证并留存原渠道本地旧版材料，写入前重验安装归属。通过 npm 或安装器恢复旧版，由原工具管理安装元数据，不手工快照还原注册表、快捷方式或 npm 全局元数据。先用隔离 fixture 证明两渠道离线旧版恢复可行，不能成立时报告阻塞，不以通用事务引擎替代。仅处理 Updater 运行中可捕获的安装/启动失败；不新增独立恢复命令或任意阶段断电自动恢复。验证：部分安装失败后旧版可启动、恢复失败保留材料、无关包不变；异常中断只验证保留诊断和阻止自动覆盖。同步文档说明原渠道手动修复方法、材料保留规则和不覆盖用户数据迁移的边界。

- [ ] 3.2 强化 Windows 启动确认，优先关联现有 `StartupRecord`、runtime descriptor、目标发行元数据及新进程身份，校验本次启动时间、版本、安装位置与 Host 链就绪；控制通道可用性若缺少可靠证据，只补必要的鉴权、无副作用探测，不预设新回执协议或第二套启动状态。不得仅凭 PID 存活或进程创建判成功；不要求 Harness 登录或 Model 网络成功。启动失败/拒绝/超时确认自有进程已退出后有界恢复旧版，报告实际恢复结果。验证：真实子进程覆盖错误版本/安装、过期启动记录、控制端不可用、立即退出、超时与正常就绪；确认 macOS 原启动行为不变。

## 4. 用户入口与发行验收

- [ ] 4.1 后端闭环完成后，移除 `packages/renderer-extension/src/settings/pages.ts` 对 Windows 的一概禁用，按后端支持性显示“更新并重启”，保留手动入口并同步多语言文案；让更新启动的新实例只关联本次操作结果，不恢复无关历史失败。Host、独立控制台和 `codexhost update` 共用 Windows 准备/接管能力，浏览器仍只有固定无参数操作。验证：Renderer settings 测试覆盖 Windows npm/EXE 可用与不支持布局、运行中状态、失败重试、恢复结果、重复点击及 macOS 原有按钮；控制台 CLI 测试区分交接成功与安装完成。同步控制台更新文档。

- [ ] 4.2 增加 Windows 原生升级 smoke，接入现有测试/CI：分别验证上一稳定版按既有方式升级到含新逻辑版本，以及含新更新逻辑版本一键升级到后续测试版本，后者必须实际运行新 Updater。npm/EXE 均覆盖非默认路径、准备后禁网、无关 Node/另一安装存活、安装失败与新版不就绪时的有界恢复。x64 实际运行；ARM64 未取得原生证据时明确标记未验收。回归 macOS npm/DMG，保护共用代码修改不改变其行为。验证命令从根 `package.json`、`tests/vitest.config.js`、crate manifest 选择；缺少 Windows 环境则保留任务未完成，不以 mock 或交叉编译替代运行证据。

## 实施记录（阶段性交付，验收未完成）

- 独立 worktree：`/Users/chongwen.zhang/work/study/codex-host-windows-one-click`；分支 `implement/restore-windows-one-click-updates`；基线 `b91511c8e846f5b0321068846b7d80991b7329e4`。规划从原工作区复制，未修改原工作区。
- 第二轮核对 #640 为 OPEN、未合并；依赖提交为 `692e6ee6d25ba061a0f5f555fd203db7fb503377`，以未提交 diff 纳入。其余无关工作区修改未纳入。第二轮新增实现相对该依赖的补丁及检查日志位于 `build/windows-update-preflight/round2-*`。

### 已实现并有聚焦测试的部分

- 1.1：Windows npm 从运行的 CLI 入口推导原 prefix，验证全局 shim、CLI/package manifest、实际 Node 模块解析归属、嵌套/提升平台包、版本、OS/CPU/发行 target；拒绝链接、跨 prefix、不明确布局及安装版本漂移。安装包校验当前根目录和 Launcher/内置 Node 归属。Rust 在解析请求及安装写入前重验，npm 命令显式 `--prefix`，EXE 显式 `/DIR`。macOS/Linux npm 不要求 Windows 字段，保留原参数与准备时机。
- 2.1：Launcher 识别 Windows `.exe` Helper；Windows Launcher 向受管运行链提供原始创建时间，准备阶段及原生交接均检查 PID/创建时间/可执行文件。临时 Updater 在写 `waiting-for-exit` 前接管同一操作锁；旧持有者释放操作时核对 operationId 和记录，不删除已转移或后续操作。Launcher 在 Windows 还核对等待中的 Helper 实例及路径。macOS 继续由 Launcher 启动 Helper，并保留 operationId 与规范化状态路径。
- Windows 操作记录保留最小的 `installationStarted` 标记。最终只读归属/摘要校验通过后，在调用可能写安装的 npm/安装器之前才设置标记。已发生写入后的失败/中断保留锁和操作目录，普通入口不自动覆盖；校验失败未进入执行器时不标为半安装。清理跳过仍被活动锁引用的目录。
- Windows 元数据变更通过稳定空文件 `.active-update-mutation.lock` 的进程生命周期句柄互斥：TS 使用 Node 数值 fs.open flags / libuv `UV_FS_O_EXLOCK`，Rust 使用 `share_mode(0)`。持有者进程结束由内核释放，不按目录年龄或超时破锁，也不删除锁文件来释放互斥。准备记录在互斥下原子发布；崩溃时不会发布空/半条活动记录。macOS 实机 fixture 使用 BSD 内核文件锁，Linux 的 Windows 状态机单测注入 guard，不充当 Windows 原生证据。没有新增恢复 CLI、helper 子命令、租约、心跳或事务日志。
- 对应测试：`distribution.test.ts`、`update-manager.test.ts`、`operation-state.test.ts`、`windows-process-identity.test.ts`；Rust 的 `windows_installation_tests.rs`、`operation_lock_tests.rs`、`operation_guard.rs`、`install.rs` 和 Launcher `active_update.rs`/环境转发测试。覆盖其他 prefix/实例、版本漂移、链接、中文空格、PID 复用、转移后释放、重复操作、写入中断留存与互斥。已有 Host/控制台/终端/ready 测试作为入口及 macOS 回归保护。
- Windows 更新按钮保持禁用。npm 的共享 Node 进程没有按名称或共享可执行路径终止；相关入口归属关闭和原生文件占用处理仍待完成。此阶段代码不是可发布的一键更新闭环。

### 第二轮检查（历史记录）

- `npm run build:typescript`、`npm run typecheck`、`npm run lint`：通过。
- 聚焦 Vitest：update-manager 的 distribution/update-manager/operation-state/updater-ready/windows-process-identity，Host update-coordinator、console updates/update-cli、release packagers，共 67 通过、3 跳过。跳过项为 Windows 状态替换重试、路径大小写及原生进程身份查询。
- `cargo test -p codexhost-updater --locked`：40 通过。Launcher 的 `active_update`：6 通过；运行环境转发聚焦测试：1 通过。
- `cargo clippy -p codexhost-updater -p codexhost-launcher --all-targets --locked -- -D warnings`：macOS 通过；Updater 的同项 Windows x64 交叉检查通过。交叉编译不算 Windows 运行证据。
- Windows Launcher 交叉检查被缺少 `llvm-rc` 阻塞，未修改构建脚本绕过资源。`cargo fmt --all --check`、改动 TS 的 Prettier check、`git diff --check`：通过。Rust 使用独立 `CARGO_TARGET_DIR`。

### 第三轮审查修复与实际回归

- 审查 1：认同目录 guard 将准备阶段崩溃永久锁死。已用真实 Node 子进程复现退出码 23、无活动锁但 guard 遗留，连续两次重试分别等待约 5013ms、5005ms 后失败。修复后 Node 24、Node 22 同一复现均连续两次毫秒级重试成功。before/after 报告在 `build/windows-update-preflight/round3-guard-crash-*`。没有使用先前提出的 guard-helper 模式；现有 fs.open/Win32 独占共享原语避免了新增调用边界。
- 审查 1 回归：`operation-state.test.ts` 用真实子进程覆盖身份读取时退出、初始记录写到一半退出、发布记录后退出、状态绑定记录写到一半退出；恢复后都可重试。另有活持有者阻止竞争、强制终止后可获得锁的回归。Rust `operation_guard.rs` 覆盖不执行 Drop 的真实子进程退出和活持有者互斥。macOS 上实际运行，不宣称 Windows 原生已验收。Node 22/24 的 libuv 头文件及 Node 22 fs.open 转发实现已静态核对。`operation-guard.test.ts` 还验证忽略独占标志时失败闭锁、不进入元数据操作，及异常探测时关闭句柄；实际持有句柄时再尝试独占打开，必须被内核拒绝。Windows 分支及真实子进程用例仍需原生执行。
- 审查 2：认同标记过早。`main.rs` 将标记放入执行边界回调，`install.rs` 在最终归属及 EXE 摘要校验通过、命令构造完成后才调用回调，然后执行 npm/安装器。`operation_lock_tests.rs` 验证摘要变化/安装身份变化均不调用回调或执行器，释放未写入锁且可以再次到达执行边界；另以真实 fixture 目标文件部分写入后报错验证仍保留标记与锁。Windows npm 最终归属失败的专属回归已加入但本机未运行。状态为 installing 但明确 `installationStarted: false` 的死操作可重试；restarting 或已写入状态仍失败闭锁。
- 审查 3：认同 PowerShell 5.1 stdout 编码风险。`windows-process-identity.ts` 在查询/序列化前显式设置无 BOM UTF-8 输出及 `$OutputEncoding`；decimal/FILETIME 微秒表达未改。便携 transport fixture 验证编码配置先于查询，完整保留中文路径；Windows 专属测试复制 Node 到中文空格目录后查询真实进程身份，本机未运行，不算原生证据。
- `npm run build:typescript`、`npm run typecheck`、`npm run lint`：通过。沿用第二轮的 9 个聚焦 Vitest 文件并增加 `operation-guard.test.ts`，共 10 文件、78 通过、4 个 Windows 专属项跳过；其中状态/编码聚焦 2 文件为 22 通过、2 跳过。
- `cargo test -p codexhost-updater --locked`：45 通过。Updater 的 macOS 与 Windows x64 交叉 Clippy `--all-targets --locked -- -D warnings` 通过。改动 TS 的 Prettier、`cargo fmt --all --check`、`git diff --check` 通过。没有运行全量测试或原生安装/更新。
- 本轮差异相对第二轮保存在 `build/windows-update-preflight/round3-only.patch`；规划复合任务仍未勾选。没有扩展离线准备、完整恢复、启动确认或 UI 能力，Windows 更新按钮继续禁用。原渠道恢复和完整升级路径仍没有 Windows 原生证据。

### 第四轮：npm 退出前准备与原生通用语义

- 1.2 已完成实现与所要求的宿主原生 npm fixture 验证。Windows 准备通过可信 Node/npm CLI 的精确 `view`/`pack` 获取 CLI 和当前平台包，校验 registry/pack/本地 SHA-512，流式检查归档闭包，再保存供原生执行器重验的 SHA-256。仅支持当前两包的封闭发行布局；缺文件、额外必需依赖、安装脚本、不安全 entry、缺包、摘要不符及超时均在退出前失败。不进行生产试装，不跨 OS 强装，不写原 prefix。
- 正式执行固定原 prefix、本地两个归档、隔离 cache 和空 user/global npmrc，严格 `--offline --ignore-scripts --omit=optional --force=false`，禁用 audit/fund/update-notifier；清除 npm 配置环境及 Node preload 注入，限时 300 秒。macOS npm 参数/准备时机与 DMG 流程不变，EXE 原有大小及 SHA-256 校验保留。
- 真实 fixture 使用本机 macOS ARM64、Node 24/npm 11.16.0、回环 registry、隔离 prefix/config/cache。拒绝网络期间，通过新 Rust npm 执行器完成 1.2.2 → 1.2.3 → 1.2.4；故意破坏 CLI 入口、平台包 JSON 并删除 Host 文件后，原生 npm 用本地旧版归档恢复到 1.2.2，CLI 可执行、平台版本及文件恢复。另一 prefix、无关包完整文件快照和用户 sentinel 均保持不变。没有手工还原 npm 元数据。这是通用 npm 恢复可行性证据，不是 Windows 恢复或真实 Host 启动验收。
- 空 cache 测试发现 npm 11 即便带 `--offline` 仍会为 update-notifier 请求 `npm` 元数据；显式禁用后测试通过。准备缺包、SRI 损坏、真实网络超时、真实文件系统 EACCES、归档完整性及 ENOSPC 注入均覆盖；失败清理材料且原 prefix 文件快照不变。归档检查不解压/执行，使用公共 `tar` 依赖；发行载荷和 npm 包包含它及五个传递依赖的许可证。
- 实际检查：TypeScript build/typecheck、lint/边界、改动文件 Prettier、Rust fmt、git diff check 通过。14 个聚焦 Vitest 文件累计 140 通过、5 个 Windows 专属项跳过；payload 旧允许列表计数修正后单独复验为 8 通过、1 跳过。Updater Cargo 单测 48 通过、1 个按需 real-npm fixture 默认忽略；该 fixture 已由 Vitest 实际调用四次。Updater macOS 与 Windows x64 交叉 Clippy `--all-targets --locked -- -D warnings` 通过，交叉检查不算 Windows 原生证据。
- 证据位于 `build/windows-update-preflight/round4-*`。Windows 原生进程/文件占用、两渠道恢复及完整启动确认仍待后续任务，不启用 Windows 按钮。

### 第五轮：共享 Node 归属关闭与本次启动确认

- 2.2 实现：Platform 使用系统 PowerShell/CIM 读取指定 image 的命令行与 decimal FILETIME 微秒，通过 Windows `CommandLineToArgvW` 解码；固定系统模块、UTF-8、4 MiB 输出和 5 秒进程预算。Updater 在交接前验证该能力及所有核心入口；共享 Node 所有者必须同时匹配入口、PID、创建时间和内核 image。交接后仅关闭已证明属于本安装的 Node 核心入口，再复用 #640 原生关闭能力处理该平台包的私有 Helper；不按 Node 名称或共享路径终止。
- Launcher 对已由真实临时 Updater 接管的 Windows 请求，按既有安装根目录识别同一安装的受管实例，使终端/独立控制台更新也可触发现有 Desktop 清理。其他安装不匹配。状态读取上限提高至有界 64 KiB，容纳材料路径较长的请求；新增回归保护。普通 Inno 界面和点击安装时机未修改。
- 3.2 实现：Windows 重启明确使用 `launch`，绑定实际 spawn 子进程的内核身份；npm 的新 Launcher 还必须由该次 wrapper 进程启动。复用 StartupRecord、runtime descriptor、发行 metadata、Host descriptor 和既有 Native gate；Host descriptor 仅新增来源 Launcher PID。补 Controller 的鉴权 PING、Host 的鉴权只读 `/ready`，不创建启动回执、第二套启动状态或新恢复命令。版本、原路径、新创建时间、新 nonce、本次进程关系、对应 Host 版本和控制链均需匹配，不能用另一次同安装启动替代本次启动。
- 真实宿主子进程回归已覆盖正常就绪、错误 Launcher/Host 版本、错误安装路径、错误启动来源、过期启动记录/descriptor、Host 未就绪、Controller 不可用和立即退出。fixture 只运行复制到隔离目录的测试二进制与隔离 Node 脚本，不启动用户 Desktop；不算 Windows 完整升级证据。
- 实际检查：Updater 单测 52 通过、2 个按需子进程 fixture 默认忽略（启动 fixture 已由父测试实际调用）；Launcher `active_update` 聚焦 8 通过。17 个聚焦 Vitest 文件 155 通过、5 个 Windows 项跳过，包含真实 npm 执行器、入口协调、发行载荷及鉴权探测。TypeScript build/typecheck、lint/边界、Rust fmt、git diff check、Updater/Platform Windows x64 交叉 Clippy，以及 Updater/Platform/Launcher macOS Clippy 均通过。第五轮相对第四轮补丁在 `build/windows-update-preflight/round5-only.patch`。
- Windows 原生共享 Node 退出/其他 prefix 存活测试与 `CommandLineToArgvW` 中文路径测试已加入并通过交叉类型检查，尚未原生运行。2.2/3.2 仍不勾选；捕获启动失败后的自有进程清理、原渠道自动恢复、权限/空间前置检查尚未完成。

### 第六轮：原版本材料、只读安装前置检查与 npm 安装失败恢复

- Windows npm 退出前同时准备目标版和原版本两套封闭材料，存于 `npm`/`npm-previous`，共享 120 秒预算；原版本不可获取时不发布请求、不启动 Helper。归档检查记录解包大小，原生请求同时验证两套 SHA-256、固定目录及空配置。原生交接前通过目录 mutation access 的 `OPEN_EXISTING` 和可用字节检查权限/空间，不写安装探针、不修改 ACL、不提权。Windows 原生 API 已交叉检查，尚未实机验收。
- 只有本次 npm 工具已经确认退出的安装失败（包括成功退出后的目标包校验失败），才允许执行一次原渠道旧版重装。最终只读归属失败或工具退出不明不会触发覆盖；旧材料损坏也不会运行修复工具。重装后验证原 CLI/平台 manifest、发行 metadata，并按原入口重启和确认原版本 Host；恢复成功仍报告更新失败，才释放保护。异常中断/恢复失败继续保留材料和锁，不建立新恢复 CLI、镜像 npm 元数据或引入事务日志。
- 宿主真实 npm fixture 已直接执行新的 `npm_recovery::restore`：目标两个连续版本安装后，故意破坏 CLI、平台包 JSON 和 Host 文件，禁网用旧版材料恢复；原 CLI 可执行、平台/文件正确，无关包和另一 prefix 保持不变。新增旧版材料缺失时恢复阻塞且保留剩余材料、原 prefix 快照不变，以及真实受控 Node 工具部分写入后退出的错误分类回归。未把这些通用证据当作 Windows/完整 Host 恢复证据。
- 实际检查：TypeScript build/typecheck、lint/边界通过。17 个聚焦 Vitest 文件 157 通过、5 个 Windows 专属项跳过；Updater Cargo 55 通过、2 个按需 fixture 默认忽略，real-npm 和 native-startup fixture 已由父测试实际执行。Updater/Platform macOS 与 Windows x64 交叉 Clippy、Rust fmt、git diff check 通过。证据在 `build/windows-update-preflight/round6-*`；相对第五轮的补丁为 `round6-only.patch`，累计实现排除 #640 依赖的补丁为 `round6-cumulative-no-640.patch`。
- EXE 恢复证据缺失单独失败闭锁：JS 启动入口在 spawn Helper 前报原渠道恢复不可用并记录失败；原生请求再次在确认接管和停止旧应用前拒绝。仍保留 EXE 下载/大小/SHA-256 校验，普通 Inno 的提取 helper、界面和点击安装行为不变。未用该阻塞停止 npm 通用实现。
- 当前剩余的恢复实现缺口：新版启动失败后，必须可靠确认本次 MSIX 活化 Desktop 及其进程树退出；现有 StartupRecord 不含该 Desktop 的 PID/创建时间，仅终止 Launcher 不能作为证明。不能据此直接调用旧版覆盖。EXE 原渠道离线恢复也仍需 Windows fixture 证明。以上路径继续失败闭锁，3.1/3.2 不勾选，不启用 Windows UI。
- 仓库已配置 `windows-latest`，但 `ci.yml` 只有 PR/push 触发且 checkout 仓库 ref，不能直接消费当前未提交补丁；唯一包含 Windows 的手动 dispatch 是发布 workflow，不能用于绕过不提交/不推送/不发布的约束。尚未取得其他可执行本轮隔离补丁的获授权 Windows fixture；不由本机 PATH 情况推断所有远程环境不存在，也未购买资源或安装 VM。

### 第七轮：保护独立 Desktop、启动失败清理与持久 npm 回归（清理保证经审查撤回）

本轮事后捕获树及清理准入不能证明完整性，不作为当前安全保证；其源码与声明已在第八轮撤回。下列检查是历史命令结果，不是该方案通过审查的证明。

- P1：Windows 更新/恢复 relaunch 共用 `launch --preserve-external-desktop`。Launcher 在未归属官方 Desktop 的提示、删除 descriptor、强停之前拒绝，不启动额外控制台，不改变普通用户启动或 macOS。回归从 Updater 生产命令构造，经真实 Node wrapper 执行 Launcher 测试二进制的参数解析/策略，更新与旧版恢复均保留真实无关 Node fixture，非 Windows 原参数保持。另有生成 npm wrapper 的参数转发回归；没有用 mock 代替该原生策略链。
- 复用原生进程监督与 StartupRecord，新增可选 Launcher 创建时间/父进程、Desktop PID/创建时间/可执行文件及清理确认字段；微秒保持十进制字符串，兼容旧记录但不把缺字段视作清理证明。Windows 更新启动在捕获 Job 前拒绝创建时间早于本 Launcher 的 Desktop，保留验证过的 Desktop Job 树与 Controller 原有 Job；Controller 未就绪也保留句柄，两个自有树均有界确认为空后才发布清理结果。原生句柄捕获失败、记录缺失、附着别的实例、PID/创建身份变化或 Launcher 崩溃未留清理确认均失败闭锁。
- Updater 启动失败时仅终止本次已证明的 Controller，复核本次 Launcher/wrapper 身份、Desktop/Host/Controller/wrapper 退出与持久清理结果，才连接一次 npm 原渠道恢复。恢复启动使用同一保护策略；仍失败则保留锁与材料。没有新增恢复 CLI、第二套启动状态/回执或手工元数据镜像。
- 真实 npm 回归持久化：由普通 registry 按包名全局安装旧版，验证平台包初始嵌套；准备本地材料后拒绝网络，离线升级为提升布局，版本正确，无关包及其真实 optionalDependency 文件快照不变，安装请求增量为零。真实 npm wrapper → Launcher 子进程正常就绪通过，另一实际父实例拒绝。
- 宿主原生进程测试覆盖：保留已验证根退出后的实际后代、仅终止自有树、伪造创建身份拒绝；清理结果缺失、附着、PID 身份不符、PID 0、无清理确认的 Launcher 退出、仍活 Host 均阻塞；只有树实际终止并记录清理确认后通过。它们不启动真实 Codex Desktop，不是 MSIX 全链路证据。
- `npm run test:update-fixtures` 已接入现有 Windows CI 配置；本机执行通过：StartupCheck 4 通过/1 按需 fixture 忽略、入口归属 2 通过、自有树 2 通过，原生 relaunch 策略父测试 1 通过（3 次 Launcher 子进程 fixture），3 个 npm/管理器文件 27 通过、1 Windows 项跳过。18 个聚焦 Vitest 文件 160 通过、5 Windows 项跳过。Updater 57 通过、3 个按需 fixture 默认忽略，均已通过父测试/显式入口实际调用；Platform 自有树 2 通过，Launcher startup record 6 通过、active_update 8 通过。
- TypeScript build/typecheck、lint/边界、改动 JS/TS Prettier、Rust fmt、git diff check、Updater/Platform Windows x64 交叉 Clippy、Updater/Platform/Launcher macOS Clippy 通过。Windows Launcher `cargo check` 仍被缺 `llvm-rc` 阻塞，未绕过资源构建，也未把宿主或交叉检查当 Windows 验收。首次策略 fixture 的 OsString JSON 序列化错误已修复，真实 fixture 入口复验通过。证据在 `build/windows-update-preflight/round7-*`。
- 新增的原生 MSIX Job 归属/空树确认与失败清理仍未在 Windows 执行，CI 配置尚未远端运行；EXE 原渠道恢复仍缺 Windows 可行性证据，自动分支继续在停止旧应用前拒绝。未启用 Windows UI，复合任务不新增勾选。

### 第八轮：撤回错误的完整性证明，在激活与覆盖前失败闭锁

- 接受父会话 P1 反例：运行中的 root 已产生 A→B，而 A 在捕获前退出，沿存活父链枚举会漏掉 B；Job 为空仅说明已纳入成员退出。没有增加扫描轮数或全系统谱系日志。删除 `OwnedProcessTree` 模块/公共导出、Windows `guard_process_tree` 及事后接管代码；不再写 Desktop `process/cleanupComplete` 清理承诺。
- 原生更新器的启动失败清理准入直接返回不支持，不读旧 `cleanupComplete` 作为授权、不终止任何进程、不再连接启动失败后的旧版覆盖。只保留 Launcher/parent 创建身份用于既有启动诊断与确认。npm 已验证的离线材料及安装工具失败后的底层软件包恢复仍保留，但不能宣称恢复后 Host 可用。
- Windows 受保护 relaunch 在控制台创建、资源解析、Launcher 附着、`ActivateApplication`、ownership 错误清理和 Job 赋值之前拒绝。删除“比 Launcher 新即自有”的检查。普通启动仍走原主体；Windows supervisor 与 macOS/Windows 普通启动主体逐字核对与 round6 相同，结果在 `round8-ordinary-comparison.log`。没有修改普通平台激活/Drop 的语义。
- 因为安全重启尚不成立，Windows npm 管理器在 spawn Helper 前记录失败，原生 request parse 再在接管/停止旧应用前拒绝；不让已知不可安全重启的自动操作先改写安装。EXE 原渠道恢复门禁不变，UI 仍禁用。材料准备、可信 npm 安装与恢复 fixture 不受此门禁替代。
- 契约核对：[ActivateApplication](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateapplication) 只保证返回履约实例 PID，没有新建/独占发起归属保证；[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 的默认子进程继承在加入之后；[EnableDebugging](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ipackagedebugsettings-enabledebugging) 是 package 级调试设置。仓库 resume helper 仅验证 `-p/-tid` 并恢复线程，未在 ResumeThread 前建立与本次激活绑定的隔离。没有证据排除并发/已有实例，因此不依赖年龄、空 roots 检查或返回 PID 推断所有权。抓取文本及源码审计保存在 `round8-*-contract.txt` / `round8-contract-audit.md`。
- 真实宿主 Node 拓扑新增两个回归：A 在观察前退出；观察开始 A 仍活、后代枚举前 A 退出。均先验证真实 root→A→B，再确认 A 已退出、B 仍活；即使写入匹配 root 身份的旧 `cleanupComplete=true`，并依次确认 root、Launcher、Host/wrapper 已退出，恢复准入仍拒绝且 B 不受影响。测试清理只用预先验证的 fixture 实例身份。API 已删除，测试不伪称仍有生产捕获窗口或完整树清理成功。
- 跨进程策略 fixture 增加 Launcher 之后启动的真实 foreign Node，以及模拟平台错误中会精确终止该测试 Node 的真实 Drop；受保护策略不进入该边界，两个 foreign 均存活。Windows 专属分支还调用真实 `launch()`，断言在资源/激活之前拒绝；该分支本机未执行。macOS 非 Windows relaunch 原参数仍验证。首次重写 fixture 漏处理 macOS 的空 argv，修复并保留失败日志后复验通过。
- 实际检查：`npm run test:update-fixtures` 通过（StartupCheck 5/1 ignored、入口归属 2、跨进程策略 1 与 3 次 Launcher 子进程、TS 27/1 Windows skipped）；18 个聚焦 Vitest 为 160 passed/5 skipped。Updater Cargo 58 passed/3 ignored，Launcher startup record 6、active_update 8 通过。TypeScript build/typecheck、lint/边界、macOS 三 crate Clippy、Updater/Platform Windows x64 交叉 Clippy 通过。未运行 Windows/MSIX；Windows Launcher 资源编译仍受缺少 llvm-rc 限制，不绕过构建，不虚报原生验收。
- 当前窄阻塞是：在应用能产生后代前，原生地同时证明本次激活所有权及建立完整隔离；MSIX resume hook 的可用时点/原子归属尚无 Windows fixture 证据。没有堆叠镜像状态、改变普通启动或写注册表/快捷方式快照。保留 1/8 完整验收，不新增勾选。

### 第九轮：实现前置隔离路径与可执行原生 fixture（非验收完成）

- 重读 proposal/spec/4.2 后按真实边界收敛：目标是本次安装资源退出及不误杀其他实例，不是全系统谱系/任意崩溃恢复。旧稳定版按既有方式安装含新逻辑版本，然后才由新逻辑升级后续版本；不额外要求新 Updater 启动前保护时代的旧 Launcher，不引入混合版本 bootstrap，也不放松版本确认。
- 实现 `WindowsLaunchJob`：Updater 在 spawn 前用系统随机源创建独有空 Job，内部 `--update-job` 传递能力；Launcher 打开并保留该句柄。Job key 不等于 package-wide RuntimeControl 环境 nonce。MSIX activation 参数携带独有标记，现有 resume helper 查询被挂起进程自身的实际命令行并确认初始线程仍挂起，匹配后赋值 Job，才恢复初始线程。无标记、其他绑定、已运行线程不获得本次归属；包级环境只作为环境，不作证据。
- 新的受保护 Launcher 路径仅在有效 caller Job 下进入，不附着、删除旧 descriptor 或强停独立实例。平台 protected activation 不使用旧 ActivatedProcessGuard；先打开固定进程句柄，再以同一句柄校验 Job 归属。激活返回其他/复用实例时保留该实例，不依赖时间、包路径或裸 PID。普通启动主体及 macOS 参数不切换到该新路径。管理器/原生请求的自动执行验收门及 Windows UI 未解除。
- Controller 也走 CREATE_SUSPENDED→赋值同一 Job→恢复初始线程，避免 Desktop 一侧修复、Controller 一侧仍先执行的竞态。结束时先以原生 active-process limit 封住新成员加入（包括已打开 Job 的迟到 helper），再终止/等待；对应 Windows 专属测试仍待执行，若 API 不支持则失败闭锁，不宣称空 Job 已获得有效准入。
- 复用 StartupRecord 的可选 `launchJob`：仅在激活返回对象验证为前置 Job 成员后发布。Updater 始终持有 spawn 前创建的原生能力，要求本次创建身份/调用关系匹配及该 Job 原生累计赋值计数为正；可选 key 存在时还必须一致。成员在字段发布前退出可由 native accounting 核实，从未赋值的空 Job/假 key 不能冒充。等待 Launcher/wrapper 退出。Host 就绪还需在该 Job 内，防包级环境下另一个 Host 冒充。覆盖恢复之前仅查询该 prefix 的原生 image/核心 Node 入口；其他持有者阻止覆盖而不被本次清理杀死。基于此条件的 npm 启动失败恢复调用已接回，旧 cleanupComplete 从不授权。
- Windows 专属源码测试：挂起进程实际命令行绑定及先赋值后执行；无标记同环境正常启动；root→A→B 中 A 已退出仍保留 B；Controller 同 Job；封闭后预先打开的迟到句柄不能恢复新进程；caller-held Job 与假持久标记的正/负准入。它们通过 Windows x64 all-target Clippy，但未原生运行。
- 实际 MSIX fixture 已实现：`npm run test:windows-appx` 编译非 Codex 测试应用、导入 DLL 的进程附着探针和 TLS 探针、真实 Launcher resume helper，注册唯一的开发 AppX 包，以同包环境下无标记实例正常执行/存活与标记实例在 DLL/TLS/main 前已归属来验证实际时点；中间父退出后叶进程必须被 Job 清理。仅限已有开发包注册权限的一次性 Windows x64 用户，不启用 Developer Mode、不导入证书、不安装/启动真实 Codex。尚未执行。
- EXE 原渠道可行性 fixture 已编写，尚未接生产：原工具同根 old→new→old、外部文件锁失败、显式软件文件部分写入故障后 old 修复，验证 app 字节/版本、原工具 DisplayVersion、另一目录 payload/实际 Node 和用户 sentinel。只对两份 EXE 增加临时程序级出站阻断，要求授权的 disposable 管理员用户，不提权、不回放 registry/shortcut 快照。`prepare/run` CLI 与非发布手动 workflow 接线已写，均未 dispatch。
- 已下载并实际校验发布材料：v0.14.0 x64 EXE 26,560,606 bytes，SHA-256 `4f33cd0eda106fa7e1e5b3c67dcdfb1b7df880b30c10a8644ff2df23d39f6cd7`；v0.15.0 x64 EXE 26,574,645 bytes，SHA-256 `9b2190ad2ea3212f64837b3d9131738273ddd2b99bae031b1e810f32d8e2e729`。只在 macOS 读取/hash，未安装，不计 Windows 降级证据。材料与 Windows-local 重准备命令在 `round9-native-execution.md`。
- 本机 llvm-rc/zig 的 PATH、Homebrew、/usr/local、/opt、Developer/Xcode、rustup、Android 与相关缓存均未找到可用工具。已核实官方最小候选 Zig 0.15.2 的 URL/SHA-256：压缩包 50,635,984 bytes，主程序 188,226,560 bytes 加头文件；只读取流式 archive header，未安装/执行。该外部工具解压需父会话批准，或由现有 Windows SDK executor 完成 Launcher 资源编译；没有修改 build.rs 跳过资源。
- 已实际执行：fixture 入口 Startup 5/1 ignored、npm_processes 2、portable activation 3、跨进程策略 1（3 Launcher 子进程）及 TS 27/1 Windows skipped；19 个聚焦 Vitest 161 passed/5 skipped；Updater 58 passed/3 ignored，Launcher startup_record 6 passed。TypeScript build/typecheck、lint/边界通过；Platform/Updater Windows x64（含 activation-fixture）全目标 Clippy 与三个 crate 的 macOS Clippy通过。Windows Launcher/full MSIX/EXE native fixture 未运行；PowerShell/C probe 仅有源码，不能称已验收。
- 具体下一步及不可替代授权在 `build/windows-update-preflight/round9-native-execution.md`：可将未提交补丁/固定材料转给已有授权 Windows executor，不要求购买/新建 VM、不推送或触发发布。局部 SDK/完整性证据不足时保持现有自动门，不把宿主/cross-check 冒充 native。复合任务维持 1/8，不勾选未完成项。

### 第十轮：真实 RC 与 Windows Launcher 编译窄阻塞关闭

- 经授权仅在 ignored 工具目录下载、核对官方 Zig 0.15.2 归档与 headers。原始 `zig rc` 自举链接失败后，以同归档未修改的 Resinator 源码显式链接 libc，使用真实 `RC_PATH` 生成 VERSION/ICON/GROUP_ICON/MANIFEST 资源；`build.rs` 未改。Windows Launcher 全目标 check/Clippy 通过，父会话亦独立复验。仅一处嵌套 if-let 改为 let-chain；补丁及完整工具来源/资源验证在 `round10-*`。这不构成 Windows 原生验收。

### 第十一轮：Job 外交接、静默安装范围及可运行 fixture 修复

- P1：接受 Node detached 不设置 CREATE_BREAKAWAY_FROM_JOB 的官方源码证据。Windows Desktop Host 在执行门后只给既有请求原子发布 `launch_via_launcher` 意图；`prepared` 本身不触发 Helper。复用 Launcher 启动职责，由旧 Desktop Job 外的 Launcher 启动 Helper，检查 Launcher/Helper 的实际 Job 归属、同一 operationId 与 Helper PID/创建时间/路径的原生锁接管，再允许清理旧 Job。没有 Broker 或任意 breakaway。独立控制台/终端仍保留直接就绪交接，macOS 启动职责不变。
- 内部 start 的委托结果没有虚构 Updater PID，不把发布意图当成原生确认。受保护 Desktop 仅传递否决用途的 Job 环境提示；直接继承该 Job 的 Helper 在接管前以真实内核 membership 拒绝，相同包级环境下非成员仍可正常交接。受信任 Launcher 确认自身在 Job 外后清除该提示再 spawn，避免跨次继承过期提示。保护清理还独立检查 waiting Updater 不在旧 Job 内。
- 交接失败保留旧 Desktop、写入既有失败状态。Host 在查询失败或重试前，通过原锁对象的串行化字节比较仅释放自己的未转移准备锁；Updater 接管及后续操作记录不能被删除。便携回归覆盖存活 Host 失败后释放/直接重试、外来或已转移记录保留、原生已清锁时幂等；没有增加启动状态或回执。
- Windows 真实 fixture 源码接入 `test:update-fixtures`：Job→Node Host 执行实际 TS 路由→Job 外 Launcher→配对 Updater 测试进程，实际调用生产身份校验、OperationLock 和等待退出逻辑；清理旧 Job 后 Helper 存活，经 Node wrapper 启动第二 Launcher，再重复第二次更新。覆盖无意图不启动、真实零退出无握手不清理、detached Node 仍属旧 Job，以及同包环境非成员不被否决。此组件不执行安装或真实 Codex，Windows 部分尚未运行。
- P1：自动 Inno 参数与实际 fixture 共用 `/NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS`，不修改普通人工 Inno UI/defaults。参数契约单测通过；原生 fixture 由独立、目标目录外的进程持有目标 exe，安装必须失败且持有者保持同一内核身份存活。Windows 原生尚未运行。
- P2：无标记 AppX fixture 改为真实 COM activation + package debugger helper，并以 retained handle 的 GetPackageFullName、精确 fixture image 和入口 trace 等待。它不调用官方 Desktop root matcher，也不使用其错误 kill guard；生产官方 Desktop 匹配未放宽。Windows 全目标编译通过，真实 MSIX 尚未执行。
- EXE 恢复 fixture 比较除 Inno 自有卸载账本外的完整软件文件集合，同时记录新版真实新增路径，并注入 `app/plugins` 新软件文件。旧工具残留新文件即严格失败并写 `recovery-evidence.json`；不通过手删文件或仅校验 metadata 冒充恢复。现有 Inno 无 InstallDelete，不能据此承诺 in-place 降级可行，生产 EXE 恢复门仍保留。
- 原生执行路径纠正：父会话提供的 repository self-hosted runners 查询为 0；这不证明 GitHub 托管 runner 不存在。移除未入默认分支、不能据新分支直接 dispatch 的 fixture workflow。复用已有 `ci.yml` pull_request：普通 Windows lane 运行组件；标题前缀 `[windows-fixtures]` 的草稿 PR 额外运行固定 EXE 原工具检查，正文另含 `[run-appx-probe]` 才尝试 MSIX。不使用发布或 pull_request_target；artifact 分开保留组件、Inno、MSIX 证据。托管 Windows Server 不支持 AppX 时直接报告失败，不视作验收。未提交、推送、创建 PR 或触发 CI。
- 实际检查：11 个聚焦 Vitest 文件 79 passed/1 Windows skipped；`test:update-fixtures` TS 38 passed/1 Windows skipped，宿主 Startup 5/1 按需 ignored、npm_processes 2、activation_binding 3、跨进程策略父测试 1 与三次 Launcher 子 fixture；Updater 58 passed/3 按需 ignored，Launcher active_update 8、startup_record 6 passed。三 crate macOS Clippy 与 Windows x64 全目标 Clippy（含 activation-fixture、真实 RC）通过；TS build/typecheck、lint/边界、Rust fmt、改动 Prettier、git diff check 通过。缺少测试 imports、lint 的 type-import 规则及新增 mock 的 TypeScript 字面量拓宽失败均保留日志，修复后复验。Windows Job/PowerShell/CIM/EXE/MSIX 及完整新逻辑→后续版本升级未运行；完整验收仍 1/8，不启用 UI。

### 第十二轮：原工具精确文件恢复与无子进程启动失败（实现待原生验收）

- 1：Updater 对 denial-only Job hint 的确切 NotFound 与 Launcher 一致，不据已销毁 Job 的环境残留拒绝独立进程；其他无法判断的错误仍失败闭锁。增加命名 Job 全部释放后再启动真实独立 Windows 子进程的回归；本机未执行该 Windows 项。
- 2 归属依据：`installed-harness-plugins.ts`/控制台根解析区分发行 `app/plugins` 和用户数据目录 plugins；`HarnessLaunchSettingsStore` 写数据目录的 `harness-launch-settings`。原工具恢复只处理构建时列出的发行文件，不假定整个自定义根或整个 app/plugins 属于发行。默认/自定义数据根、未知用户插件、未知文件均保护；路径碰撞、修改过的内置文件、reparse/symlink/hard-link 及目录类型转换在旧实例退出前拒绝。
- 新增具体 `codexhost-inno-files-v1` 文件能力：载荷内精确路径/字节/SHA-256 清单与 Release 的 EXE SHA-256 绑定描述符。旧能力缺失或旧清单无法与安装匹配时保留人工原渠道原目录入口；不执行旧 EXE 试探未知参数。Windows 先取得两版 EXE/描述符和文本材料，暂存不得在安装内；原生重验、目录权限/空间检查在交接前和写入前进行。Windows 传输按文件有两分钟预算，macOS 调用保持原参数。
- 原 Inno 的内嵌自身清单与显式 `CODEXHOSTREPLACEFILES` 清单求差：仅删除被替换发行独有文件，不删未知文件/目录、不调用卸载器清空根、不读取/回放 registry 或卸载账本。该机制同时用于目标安装及本地原版恢复；普通 UI 未传参数时不清理。文件清理在现有 PrepareToInstall 中、#640 已确认关闭成功后执行；失败沿原返回错误路径阻止复制，不依赖 CurStepChanged 异常能否中止安装。官方脚本 API/事件文档已抓取核对，不算 Inno 编译证据。
- 生产 EXE 准备、原生 preflight、固定 /DIR 工具执行、完整目标文件验证、本地原工具恢复、原版自身 Launcher/Runtime 重启已接入现有分渠道主流程，但自动执行门/UI 保留。工具受前置 Job 约束并有五分钟预算；明确禁用额外 close/restart，3010 需重启/潜在排队写入不授权自动恢复。材料损坏、工具/启动状态未知、恢复失败保留锁、材料与 Inno 日志。
- 3：`relaunch_in_job` 明确仅返回 Windows Command::spawn 的 io::Result；读取当前 rustc 1.97.1 对应官方源码，CreateProcessW 成功后直接构造 Ok，无后续可失败 IO。明确无子进程的 spawn Err 纳入两渠道有界恢复；capture/Job setup/bind/未知清理仍 Unproven，不据空 Job 覆盖。恢复后启动也用同一分类，失败报告原软件/启动实际结果且不递归恢复。加入 Windows 缺失真实 Launcher、仍活错误 image bind 及便携恢复资格测试；Windows 部分未运行。
- fixture：保留 0.14/0.15 旧能力调查，并增加 `build-v1/run-v1`。仅在授权 Windows x64 scratch 中复制源码并分别构建 99.0.1/99.0.2，复用真实发行/Inno 脚本并检查 Launcher 二进制及 Runtime metadata 版本；不修改当前版本或发布。下一版插件文件在 ISCC 前进入载荷、清单及真实 Inno 文件表，验证占用失败/外来持有者存活、完整软件回装、未知用户插件及自定义根数据保留。fixture 调用生产安装/恢复核心，但不执行完整 apply 或启动真实 Codex；不能冒充完整一键升级验收。既有草稿 PR CI 默认准备 v1，旧能力调查单独 `[run-legacy-inno]`，MSIX 单独 `[run-appx-probe]`。没有创建 PR/运行远端。
- 本机实际检查：16 个聚焦 Vitest 文件 138 passed/3 skipped；fixture TS 48 passed/1 Windows skipped，宿主 Startup 5/1 按需 ignored、npm_processes 2、恢复资格 1、EXE preflight 4、activation_binding 3、relaunch 策略父测试 1 与三次子进程。Updater 63 passed/3 按需 ignored。三 crate macOS 和 Windows x64 全目标 Clippy（含 activation-fixture/真实 RC）、TS build/typecheck、lint/边界、Rust fmt、OpenSpec strict validate 通过。首轮 exact-optional 参数、dead code、ESLint non-null 等失败保留日志；测试临时目录命名补并发唯一性后复验通过。Windows Job/MSIX/Inno（包括 Pascal 编译）及完整 Codex/真实 macOS 升级均未执行；复合验收仍 1/8。

### 第十三轮：apply 编排、真实 smoke 入口及支持性一致（未原生验收）

- 3.1/3.2：Windows 主流程归入私有 `windows_apply`，复用现有 request、OperationLock、状态写入、安装器和启动失败类型；按原渠道先恢复软件，再用恢复版本自身入口启动一次，不递归恢复，不按错误字符串判断准入。不新增 CLI、请求字段、生产开关或状态。非 Windows 主流程保持原调用语义。
- 可执行聚焦编排测试在测试内部替换进程交接、静止查询、安装工具实际文件工作和启动结果；JSON/schema/路径/发行及材料校验、安装/恢复调用、真实锁与状态落盘均复用生产实现。覆盖成功、部分写入后恢复、明确无子进程和已证明清理后的启动失败、原版启动失败不递归、capture/bind/cleanup 未知不覆盖、待重启/工具未知拒绝、恢复失败/材料变化及相应锁与最终 failed。另验证 npm/EXE 的类型证据不能互认，文本不能授权恢复。test-only 请求入口不会编入生产；原生 apply 仍先走实际解析和禁用门。便携测试不证明 Inno、Job、真实 Host 或完整 Windows CLI apply。
- 4.1：公共支持性函数与 Windows 当前执行门一致。Host/独立控制台发现更新仍返回 updateAvailable，但 installationAvailable 为 false，并给原 npm prefix 或原安装目录人工路径；start 在准备锁/下载/交接前拒绝。status 保留实际 failed 和诊断，附手动说明，无操作时 null，不创造“失败操作”或新的恢复状态，也不把历史未知安装说成已保全。控制台 CLI 不再先报可安装后才失败。macOS/Linux 既有支持性不获得 Windows 限制，Renderer 未开放。
- 4.2：既有 fixture 入口增加 `smoke --manifest` 的真实 Codex/Host 正常连续生命周期代码。仅首次用 native test binary 调用实际受保护启动；随后两次通过真实 Host 固定接口、安装版自身 Updater 及 native apply，不人工重装/重启中间版。核对三版精确软件摘要、实际结果、新 PID/nonce、StartupRecord、Controller/Host ready；不混用 Launcher/Runtime，不替代生产版本发现，不发布、不安装/注册 Codex。当前生产门仍禁用，入口先拒绝；真实执行所缺为经审查的一致候选构建门处理、三个依次可发现的精确发行材料，以及已有 Codex/激活权限的一次性交互 Windows 用户。没有环境变量或 manifest 开门。只准备正常连续场景，真实 Codex 禁网/故障恢复 smoke 编排尚未补齐，已有正常连续入口未执行；99.0.1/99.0.2 软件核心证据不升级为完整 apply。
- 4.2 来源修复：真实 esbuild 反例证明整个 node_modules junction 会回到另一工作区 dist。fixture 现在只链接共享第三方依赖，31 个 workspace 链接回私有副本并在那里重新编译；实际 Host/Controller/Console/Renderer/插件 bundle 输入与输出摘要留在载荷外 runtime-source-evidence.json，越过副本的第一方输入直接失败。Renderer 仅将既有构建提取为可返回输入审计的函数，未修改页面/UI。真实 Host bundle 构建还发现离线校验已使用的 tar 不在允许列表，已补精确允许项及发行构建回归，不升级依赖。
- 本机实际检查：19 个聚焦 Vitest 文件 93 passed/2 skipped；fixture TS 11 文件 58 passed/1 Windows skipped，宿主 apply 编排 10 个分组（含零退出但目标文件/metadata 校验失败的恢复分支），其余 Startup/入口/恢复/activation/relaunch 分组通过。Updater 73 passed/3 按需 ignored；三 crate macOS 与 Windows x64 全目标 Clippy（真实 RC/activation-fixture）、TS build/typecheck、lint/边界、Rust fmt、Prettier、OpenSpec strict validate、diff 检查通过。另以真实构建器在 macOS 私有副本完成 31 workspace、23 bundle 的第一方输入/输出摘要审计；仅 JS 构建，不是 Windows 安装或 Codex 启动。初次 native fixture 编译、冗余闭包/非 Windows 字段 Clippy、诊断脚本复制无 dist 的 MJS workspace 失败日志保留，修复后复验。
- 检查与来源证据位于 `build/windows-update-preflight/round13-*`。Windows Job/MSIX/Inno（含 Pascal）、完整真实 Codex 连续升级和 macOS 真升级均未执行；自动门/UI 不开放，复合验收保持 1/8，其他任务不勾选。没有提交、推送、PR、发版、远端 CI 或委派，也未操作真实安装/Desktop。

### 尚未完成及平台限制

- 当前完成 1/8（1.2）；其余复合任务保持未勾选。1.1/2.1 已有上述新增实现，但 Windows 原生大小写/junction/创建时间/Helper 交接测试、跨入口真实进程生命周期和异常占用尚未运行，不能将编译或 mock 当作验收。
- 3.1 的宿主 npm 离线部分写入恢复已获上述真实证据，仅底层 npm 工具失败后的软件包恢复有可信 fixture 证据；启动失败恢复已有 caller-held pre-execution Job 条件路径，但该原生方案尚未运行验收；Windows npm 自动执行仍在交接前阻塞。EXE 的 v1 精确文件准备/原工具差集清理/恢复/原版启动已有实现，尚未经过真实 Windows/Inno/Host 验证；npm/EXE 原生证据均缺失，生产执行门不解除。首轮跨平台 npm 探针被 npm 11.16.0 的 `EBADPLATFORM` 拒绝，只说明 macOS 不能执行该探针；不证明方案不可行。没有使用 `--force` 绕过平台约束。
- 3.2 的目标版本、安装位置、本次 spawn 进程及 Host/控制链验证已有上述实现；round7 的错误事后捕获已撤回；round9 新增真实命令行绑定、pre-resume Job、Controller 挂起启动及条件恢复源码，无 caller 能力仍拒绝，自动执行门未解除。没有 Windows/MSIX 原生所有权、执行前隔离或完整升级运行证据。4.1 未启用 UI。4.2 未执行“含新更新逻辑版本 → 后续测试版本”，Windows x64/ARM64 与 macOS npm/DMG 真实升级均未验收。
- 本机是 macOS，尚无本轮 Windows 原生结果。已准备无需先合并的草稿 PR/既有 CI 路径，提交、推送、创建草稿 PR 及相应远端运行仍待明确授权；没有通过新分支 dispatch 的承诺，不再将泛泛寻找机器作为实施下一步。缺少 Windows 证据不阻塞可在本机完成的实现。
- 父会话需重点检查 Windows 原始创建时间的跨 Rust/PowerShell 表示、schema 1 下新增必需身份字段的失败兼容、TS/原生互斥和锁接管顺序、原 prefix/DIR 的二次验证，以及尚未完善的失败/恢复/启动确认不能误当生产保证。
- 没有提交、推送、发 PR、发布、委派外部 Agent，未启动或关闭用户 Desktop、未操作实际全局安装。
