## ADDED Requirements

### Requirement: 四目标发布矩阵

发布系统 MUST使用同一目标注册表支持`macos-arm64`、`macos-x64`、`windows-x64`和`windows-arm64`，并固定Rust target、Node.js 24.13.1官方归档、归档SHA-256、可执行文件名、安装器架构和允许的构建宿主。

#### Scenario: 构建已注册目标

- **WHEN**开发者在匹配的操作系统上请求已注册目标
- **THEN**发布系统 MUST使用目标固定的Rust target和Node归档
- **AND** MUST NOT从PATH或开发机当前Node推断发布Runtime

#### Scenario: 请求未知或跨操作系统目标

- **WHEN**开发者请求未知目标，或macOS宿主请求Windows目标，或Windows宿主请求macOS目标
- **THEN**发布系统 MUST在构建前明确拒绝并返回非零状态
- **AND** MUST NOT生成最终分发artifact

### Requirement: 固定自包含Payload

发布系统 SHALL生成固定allowlist Payload，包含Launcher、Shim、私有Node.js Runtime、Pi-only Host Runtime、Desktop Controller、生产Renderer Bundle和第三方许可证。Payload MUST NOT依赖源码仓库、用户全局Node.js、npm或Rust。

#### Scenario: 生成完整Payload

- **WHEN**目标构建、Node校验和Bundle审计成功
- **THEN**Payload MUST位于`build/release/<version>/<target>/payload`
- **AND** MUST只包含规格规定的十个文件

#### Scenario: 发布Payload被移动

- **WHEN**完整Payload或安装后的资源位于仓库之外或包含空格的绝对路径
- **THEN**Launcher和私有Node Runtime MUST使用相对布局定位运行资源
- **AND** MUST NOT引用源码仓库绝对路径

### Requirement: 固定Node Runtime供应链

发布系统 MUST从目标固定的Node.js 24.13.1官方归档准备私有Runtime，并在缓存使用、解包和复制前验证归档SHA-256。校验失败时 MUST拒绝生成最终artifact。

#### Scenario: 官方归档校验通过

- **WHEN**下载或缓存归档SHA-256与目标注册值一致
- **THEN**发布系统 SHALL只复制目标Node可执行文件和LICENSE
- **AND** MUST NOT回退到PATH、nvm或其他本地Node

#### Scenario: 缓存归档被修改

- **WHEN**缓存文件存在但SHA-256不匹配
- **THEN**发布系统 MUST拒绝使用该缓存
- **AND** MUST清理本次下载或解包临时文件

### Requirement: Pi-only Host Runtime

公开Payload中的Host Runtime MUST从只注册Pi的正式入口构建，MUST NOT包含Claude Code Adapter、Anthropic SDK、Claude平台二进制或其他未启用Harness运行依赖。

#### Scenario: 构建Host Runtime Bundle

- **WHEN**发布系统构建Host Runtime
- **THEN** MUST产生单个Node.js 24 ESM Bundle
- **AND** metafile MUST确认PiAdapter和AppServerHost存在且Claude Code相关输入不存在

### Requirement: macOS DMG

macOS发布系统 MUST生成标准`codexhost.app`，将Runtime资源放入`Contents/Resources`，执行ad-hoc签名验证，并用系统`hdiutil`生成包含Applications拖拽入口的目标独立DMG。

#### Scenario: 生成macOS artifact

- **WHEN**macOS目标Payload完整
- **THEN**Launcher MUST位于`Contents/MacOS/codexhost`
- **AND**Shim、Node、Host Runtime、Desktop Controller、Renderer和许可证 MUST位于`Contents/Resources`对应子目录
- **AND**DMG根目录 MUST包含`codexhost.app`和指向`/Applications`的符号链接
- **AND**最终artifact MUST命名为`codexhost-<version>-<target>.dmg`

#### Scenario: 点击安装后的App

- **WHEN**用户不带CLI参数启动`codexhost.app`
- **THEN**Launcher MUST使用随包资源并让生产Renderer初始选择Pi
- **AND**Host未标记创建 MUST使用Codex fallback，Pi创建 MUST使用既有transport carrier
- **AND**显式`launch --agent codex|pi` MUST保持可用并决定生产Renderer初始选择

### Requirement: Windows WiX 4 MSI

Windows发布系统 MUST使用WiX Toolset 4生成per-user MSI，并为x64和arm64目标选择对应安装器架构。

#### Scenario: 生成Windows artifact

- **WHEN**Windows目标Payload完整且固定WiX 4 CLI可用
- **THEN**MSI MUST安装完整固定Payload并创建开始菜单快捷方式与卸载注册
- **AND**最终artifact MUST命名为`codexhost-<version>-<target>.msi`

#### Scenario: WiX不可用或构建失败

- **WHEN**WiX 4 CLI缺失或返回失败
- **THEN**发布命令 MUST返回非零状态
- **AND** MUST NOT生成或保留一个被报告为成功的MSI

### Requirement: 四目标Release Workflow

发布系统 SHALL在GitHub Release和手动触发时使用真实macOS与Windows Runner构建四个独立目标，并且只上传最终安装artifact及其SHA-256旁车。

#### Scenario: CI构建四目标

- **WHEN**Release Workflow运行
- **THEN**macOS arm64与x64 MUST使用对应原生架构Runner
- **AND**Windows x64与arm64 MUST在Windows Runner使用各自Rust和WiX架构
- **AND**Workflow MUST NOT上传Payload目录或未压缩App目录

### Requirement: 最终artifact完整性

发布系统 SHALL只为最终`.dmg`或`.msi`生成SHA-256旁车文件，不生成内部Payload Manifest或逐文件SHA清单。

#### Scenario: artifact成功生成

- **WHEN**平台打包器生成非空artifact并通过结构检查
- **THEN**发布系统 MUST写入同名`.sha256`文件
- **AND**该文件 MUST包含artifact SHA-256和文件名

### Requirement: 构建状态与运行支持分离

发布系统 MUST区分Payload构建、安装产物验证和真实Desktop运行验证。生成DMG或MSI MUST NOT自动声明该架构获得真实Codex Desktop支持。

#### Scenario: 只完成artifact验证

- **WHEN**目标artifact成功生成但未执行对应平台真实Desktop Gate
- **THEN**验证记录 MUST把artifact构建记为通过
- **AND** MUST把Runtime支持保持为`not-run`
