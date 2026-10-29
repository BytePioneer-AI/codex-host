## MODIFIED Requirements

### Requirement: Installed distribution determines update execution

更新能力 SHALL 验证当前安装的严格发行元数据、平台与架构，并使用从该安装及 Launcher 身份派生的绝对运行路径。更新 MUST 保留发行方式和安装位置。Windows npm 更新 SHALL 验证当前 CLI、平台包与同一全局安装位置的归属，不依赖当前终端的默认安装位置；不支持或不明确的安装布局 SHALL 在退出前失败。

#### Scenario: npm distribution starts an update
- **WHEN** packaged metadata identifies npm and the fixed npm runtime paths are available
- **THEN** Host SHALL prepare the exact discovered version through the npm update path and SHALL NOT select a DMG or EXE

#### Scenario: Installer metadata does not match host target
- **WHEN** packaged metadata declares a target different from the running platform and architecture
- **THEN** automatic update SHALL fail before download or process shutdown

#### Scenario: Windows has multiple npm installations
- **WHEN** 正在运行的 codexhost 来自一个 npm 全局安装位置，但当前终端默认指向另一个位置
- **THEN** 更新 SHALL 仅作用于正在运行的安装
- **AND** 另一安装、共享 Node.js 和无关 npm 包 SHALL 保持不变

#### Scenario: Windows npm ownership cannot be verified
- **WHEN** 当前包来自开发链接、非全局安装、越界路径或无法验证的包布局
- **THEN** 自动更新 SHALL 在停止应用或修改安装前失败，并保留手动更新入口

### Requirement: Installer preparation reports bounded download progress

安装包下载 SHALL 持久化有界进度，并在大小和 SHA-256 校验通过后才能完成准备。Windows npm 更新 SHALL 在退出前取得并验证目标精确版本的 CLI 与匹配平台包，确认后续安装不依赖网络；可以仅报告阶段进度。macOS/Linux npm 保持原有准备与安装时机。准备失败 SHALL 保持旧应用运行、清理无效下载并报告有界错误。

#### Scenario: macOS DMG download is active
- **WHEN** a verified macOS Release asset is being downloaded
- **THEN** status SHALL expose bounded downloaded and total byte counts
- **AND** the fixed status operation SHALL remain responsive
- **AND** the managed Desktop SHALL remain running until download and verification finish

#### Scenario: Installer download fails
- **WHEN** artifact download, size validation, or digest validation fails
- **THEN** status SHALL become `failed` with bounded error text
- **AND** the temporary artifact SHALL be removed
- **AND** the Launcher SHALL NOT stop the managed Desktop for that failed operation

#### Scenario: Windows npm target is not completely available
- **WHEN** GitHub 目标版本对应的 npm CLI 或平台包缺失、版本不符、完整性校验失败或准备超时
- **THEN** 更新 SHALL 失败而不是安装其他版本或省略平台包
- **AND** 当前应用 SHALL 保持运行

#### Scenario: Network disappears after Windows preparation
- **WHEN** Windows 更新已完成所有下载、校验和恢复准备，网络随后断开
- **THEN** 正常安装与安装失败后的恢复 SHALL 不依赖网络下载

### Requirement: Update starts once and stops the managed Desktop process tree

Host SHALL 跨进程串行化更新。Windows Desktop 由发起端请求旧 Desktop Job 外的受信任 Launcher 启动临时 Updater；独立控制台及终端可直接启动，继承旧 Desktop Job 的 Helper MUST 在接管前拒绝。macOS Desktop 保持 Launcher 启动方式。只有准备完成、Updater 验证旧进程身份并确认接管后，Launcher 才能停止自有 Desktop 树，不调用 Electron 退出接口。Windows 接管 SHALL 在旧所有者退出后仍维持互斥；Updater SHALL 在精确旧进程退出后才安装。独立控制台及终端入口 SHALL 遵守相同 Windows 交接约束。

#### Scenario: User starts the current candidate
- **WHEN** no update operation is active and the current candidate remains the latest stable Release
- **THEN** exactly one helper SHALL start outside the old Desktop Job and the Launcher SHALL stop the owned Desktop process tree after that helper has taken the same operation lock and is waiting for exit
- **AND** a subsequent update from the restarted instance SHALL preserve this handoff and helper-survival guarantee

#### Scenario: User clicks update repeatedly
- **WHEN** a prepared or active operation already exists
- **THEN** Host SHALL return its bounded current status and SHALL NOT prepare another artifact or start another helper

#### Scenario: Launcher does not exit
- **WHEN** the managed Launcher remains alive past the Updater wait timeout
- **THEN** the helper SHALL record failure and SHALL NOT modify the installed distribution

#### Scenario: Windows owner exits while installation is active
- **WHEN** 旧 Host 或控制台已经退出，但接管的 Updater 仍在安装、重启或恢复
- **THEN** 其他入口 SHALL 仍视该操作为活动更新，不得因旧所有者退出而清除锁或开启第二次更新

#### Scenario: Windows helper fails before accepting ownership
- **WHEN** 临时 Updater 无法启动、提前退出、身份不符或未在有界时间内确认接管
- **THEN** 当前应用或控制台 SHALL 保持运行
- **AND** 不得开始安装或报告交接成功

### Requirement: Release installation remains platform-specific

更新 SHALL 保留精确版本 npm 安装、Windows 每用户静默安装和 macOS 同文件系统 App 替换与重启。Windows 安装 SHALL 显式使用已验证的原安装位置，不使用安装器记忆位置或 npm 默认位置替代。权限或平台策略失败 SHALL 被报告，不自动提权。macOS npm 与 DMG 的现有更新方式、参数和启动语义 SHALL 不因 Windows 能力而改变。

#### Scenario: macOS parent directory is not writable
- **WHEN** the Updater cannot stage or replace the App in its current parent directory
- **THEN** it SHALL preserve or restore the prior App and record a permission failure without invoking hidden privilege escalation

#### Scenario: Windows installer remembers another directory
- **WHEN** 安装器记录的位置与本次更新所验证的正在运行安装不同
- **THEN** 更新 SHALL 仅修改本次目标安装，不跳转到记忆位置

#### Scenario: Existing macOS updates remain available
- **WHEN** macOS npm 或 DMG 用户执行现有更新
- **THEN** 更新 SHALL 继续使用其既有平台流程，不要求 Windows 恢复记录或 Windows 启动确认

## ADDED Requirements

### Requirement: Windows exposes one-click updates without changing installer interaction

Windows 已验证支持的 npm 和安装包发行 SHALL 在现有更新页提供“更新并重启”，并保留手动更新入口。用户点击后 SHALL 在准备完成后重启当前受管实例，不再要求额外的安装器关闭确认。仅检查更新或打开安装器 SHALL NOT 关闭应用。此能力 MUST NOT 引入无人授权的自动重启或跨发行迁移。

#### Scenario: A Windows update is installable
- **WHEN** 已发现更新且当前 Windows 安装通过支持性检查
- **THEN** 更新页 SHALL 显示“更新并重启”并使用已验证的当前发行路径

#### Scenario: Merely checking does not stop work
- **WHEN** 用户检查更新、查看说明，或打开后取消普通安装器而未开始安装
- **THEN** 当前应用 SHALL 保持运行

### Requirement: Windows shutdown is limited to the owned installation

Windows 更新 SHALL 在修改文件前确认本次安装的旧进程已退出，并对短暂文件占用进行有界重试。共享 Node.js 路径或相同进程名 MUST NOT 单独构成终止进程的依据。其他安装、无关 Node.js 进程和独立官方 Codex 实例 MUST NOT 因本次更新而被终止。无法安全解除占用时 SHALL 报告失败，不带锁强行覆盖。

#### Scenario: A console still holds installation files
- **WHEN** Desktop 已退出，但同一安装的独立控制台仍占用待替换文件
- **THEN** 更新 SHALL 验证并关闭该自有进程，确认退出后再安装
- **AND** 其他安装的控制台 SHALL 不受影响

#### Scenario: Another application uses the same Node.js executable
- **WHEN** Windows npm 更新使用的系统 Node.js 也被其他应用使用
- **THEN** 更新 MUST NOT 按 Node.js 可执行路径或进程名批量终止这些进程

#### Scenario: File occupancy exceeds the retry budget
- **WHEN** 文件占用持续超过有界重试期限
- **THEN** 更新 SHALL 失败并保留或恢复旧版本，不等待无限期或要求系统重启完成半安装

### Requirement: Windows update success requires target startup readiness

Windows 更新 SHALL 仅在本次重启的目标实例就绪后报告成功。确认 MUST 匹配目标版本、原安装位置和新进程身份，并证实 Launcher 的 Host 链及控制通道可用。过期启动信息、旧进程存活、安装器零退出码或进程创建成功 MUST NOT 单独作为成功依据。确认 SHALL 有有界超时，不要求 Harness 账号或模型服务在线。

#### Scenario: Another installation is already running
- **WHEN** 更新重启遇到其他版本或其他安装的存活实例
- **THEN** 该实例 SHALL NOT 满足本次更新的就绪确认
- **AND** 更新 SHALL 失败并执行针对本次安装的恢复，不终止那个无关实例

#### Scenario: Target executable starts but Host does not become ready
- **WHEN** 新 Launcher 已启动，但对应 Host 链或控制通道未在期限内就绪
- **THEN** 更新 SHALL NOT 报告成功或丢弃旧版恢复材料

#### Scenario: New instance becomes ready
- **WHEN** 本次重启的目标安装、版本和新进程身份均匹配，且受管启动链就绪
- **THEN** 更新 SHALL 报告成功
- **AND** 可在不影响运行的前提下清理旧版恢复材料

### Requirement: Windows failures preserve a recoverable installation

Windows 更新 SHALL 在停止旧应用前检查权限、空间并准备经验证的本地旧版恢复材料。Updater 运行中检测到安装或目标启动失败时 SHALL 有界地尝试经原安装渠道恢复并启动旧版，不修改用户数据或无关包。恢复失败或异常中断 SHALL 保留材料、诊断和手动修复路径，不自动重试覆盖未知安装状态。恢复成功仍 SHALL 报告更新失败。本能力不保证任意阶段崩溃或断电后的自动恢复。

#### Scenario: Recovery preparation fails
- **WHEN** 恢复材料不完整、空间不足或目标安装无写入权限
- **THEN** 更新 SHALL 在停止旧应用和写入目标安装前失败

#### Scenario: Windows installation or startup fails
- **WHEN** 安装部分写入后失败，或新版被系统策略拒绝、立即退出、未确认就绪
- **THEN** 更新 SHALL 在确认本次操作产生的自有进程退出后，使用已准备的原渠道材料尝试恢复并启动旧版
- **AND** SHALL 报告更新失败及恢复结果，不把恢复操作的成功当作更新成功
- **AND** 当原渠道恢复与旧版启动均成功时 SHALL 恢复旧版可用状态

#### Scenario: Updater is interrupted during replacement
- **WHEN** Updater 在安装或恢复中异常退出，之后用户调用仍可执行的启动或更新入口
- **THEN** 系统 SHALL 根据未完成状态报告需要修复，而非仅因所有者退出就自动重试安装
- **AND** 已准备的安装目录外恢复材料 SHALL 保留，普通入口不可用时也可按文档使用原安装渠道手动修复
- **AND** 系统 MUST NOT 宣称已经自动恢复一致安装

#### Scenario: Rollback is also blocked
- **WHEN** 旧版恢复因占用、权限或存储故障无法完成
- **THEN** 系统 SHALL 保留恢复材料、失败状态和可供手动修复的诊断
- **AND** SHALL NOT 报告成功、自动删除仍需修复的操作材料或继续覆盖未知状态的安装

#### Scenario: Original installer has no verified file recovery capability
- **WHEN** 原安装器缺少可验证的精确发行文件恢复能力，或本地原版本材料不能绑定到该能力
- **THEN** 更新 SHALL 在停止旧实例前拒绝，并保留原渠道、原目录的人工路径

#### Scenario: New installer introduces software files
- **WHEN** 含新逻辑版本更新到后续测试版本后需要原渠道恢复
- **THEN** 原安装工具 SHALL 恢复原发行文件，并清理后续版本独有的发行文件
- **AND** SHALL 保留自定义根目录内的未知用户文件、用户插件及数据，不通过无条件清空目录完成恢复

#### Scenario: Relaunch fails without creating a child
- **WHEN** 安装完成后的原生 spawn 明确未创建子进程，且本安装资源已确认静止
- **THEN** 更新 SHALL 将该捕获失败纳入有界原渠道恢复，仍报告更新失败

#### Scenario: Relaunch state cannot be proven
- **WHEN** capture、bind 或清理失败使已启动进程状态无法证明
- **THEN** 更新 SHALL 保留材料与安装保护，不据空 Job 或无就绪记录授权覆盖
- **AND** 原版恢复启动失败 SHALL 报告实际软件/启动结果，不递归重试恢复

#### Scenario: Restarted instance observes its update result
- **WHEN** 新版或恢复后的旧版由本次更新重启
- **THEN** 其更新入口 SHALL 展示本次操作的最终结果
- **AND** 无关的新会话 SHALL NOT 把其他历史操作当作当前更新
