## Why

codexhost已经能够生成自包含发布Payload，但用户仍然拿不到Finder可双击的macOS应用或Windows安装器。现有`packages/release-staging`还把构建期基础设施表达成应用Runtime Package，并维护内部Manifest、逐文件SHA和目录事务，增加了不必要的发布框架成本。

现在需要把已验证的Node、Host Bundle和目标矩阵收敛成窄幅构建脚本，并直接生成平台原生安装产物。

## What Changes

- 将正式发布构建代码从npm Workspace Package迁移到`scripts/release/`，聚焦四目标Payload准备和平台打包编排。
- 保留Node.js 24.13.1官方归档、固定SHA-256、注册Pi/Claude Code的Host Bundle和固定文件allowlist。
- 让Launcher同时支持普通Payload布局和标准macOS`Contents/Resources`布局；无参数点击默认以Pi组合启动。
- 使用薄Shell脚本创建macOS `.app`、执行ad-hoc签名，并通过系统`hdiutil`生成包含Applications拖拽入口的独立架构DMG。
- 使用WiX Toolset 4声明式源码和PowerShell入口生成Windows x64与arm64 MSI。
- 只对最终`.dmg`和`.msi`生成SHA-256旁车文件，不再生成内部Release Manifest和Payload SHA清单。
- 分别记录构建成功、安装产物验证和真实Desktop Runtime验证；未经真实目标宿主验证不得宣称支持。

## Capabilities

### New Capabilities

- `cross-platform-release-staging`: 定义四目标自包含Payload及其macOS DMG和Windows MSI交付契约。

### Modified Capabilities

无。

## Impact

- 根`package.json`发布命令、`scripts/release/`和`tests/release/`。
- 删除`packages/release-staging` Workspace Package及其Project Reference。
- `crates/launcher`安装资源定位和无参数启动行为。
- `packages/host-runtime`的Release Composition Root作为正式Bundle入口，默认注册Pi与Claude Code。
- `build/release/`继续作为Git忽略的中间与最终产物目录。
- macOS使用系统`codesign`和`ditto`；Windows构建宿主需要固定WiX Toolset 4 CLI。
