## Context

当前实现已验证四目标注册表、Node.js 24.13.1官方归档与SHA-256、Pi-only esbuild Bundle，以及macOS arm64/x64自包含目录。实现位于`packages/release-staging`，包含通用原子目录替换、内部Manifest和逐文件SHA清单，但没有生成可安装产物。

codexhost不拥有第二套主UI，不打包或修改官方Codex Desktop，也不自动安装Pi。首版公开组合只包含Pi。macOS不购买Developer ID、不公证；Windows目标安装器为WiX 4 MSI。四个目标保持独立产物，不生成Universal Binary。

## Goals / Non-Goals

**Goals:**

- 用窄幅构建脚本生成四目标固定Payload，并直接生成macOS DMG或Windows MSI。
- 固定Rust target、Node归档、SHA-256、可执行文件名和允许的构建宿主。
- 生成不含Claude Code实验依赖的Pi-only Host Runtime单文件Bundle。
- 使用标准macOS App资源布局和Windows per-user安装布局。
- 只校验固定Payload allowlist和最终分发artifact，减少发布基础设施状态。
- 将构建结果、安装包验证和真实Desktop运行支持表达为不同证据。

**Non-Goals:**

- 不引入Electron、Tauri、cargo-packager、cargo-dist、NSIS或第二套主UI。
- 不生成macOS App ZIP、PKG、Universal Binary、Developer ID签名、Apple公证或Authenticode签名。
- 不实现自动更新、Pi安装、官方Codex Desktop重打包或产品功能。
- 不在缺少对应平台环境时宣称目标已获得真实运行支持。

## Decisions

### 1. 发布基础设施使用平台原生薄脚本

发布源码统一位于`scripts/release/`：共享Payload逻辑在目录根部，macOS与Windows封装分别位于`macos/`和`windows/`；测试位于`tests/release/`。它们是构建基础设施，不是安装后运行的应用Package，也不放入只拥有Gate和Probe的`tools/`。

不选cargo-packager：它只简化macOS部分，Windows MSI仍固定依赖WiX 3，不能满足WiX 4；为单一简单App再引入一套打包器不会减少总体维护面。不选Tauri或Electron：codexhost不需要额外应用UI和WebView Runtime。

### 2. 一个目标注册表拥有全部供应链差异

| Target | Rust target | Node archive | Build host | Installer arch |
| --- | --- | --- | --- | --- |
| `macos-arm64` | `aarch64-apple-darwin` | `node-v24.13.1-darwin-arm64.tar.gz` | macOS | arm64 |
| `macos-x64` | `x86_64-apple-darwin` | `node-v24.13.1-darwin-x64.tar.gz` | macOS | x64 |
| `windows-x64` | `x86_64-pc-windows-msvc` | `node-v24.13.1-win-x64.zip` | Windows | x64 |
| `windows-arm64` | `aarch64-pc-windows-msvc` | `node-v24.13.1-win-arm64.zip` | Windows | arm64 |

目标注册表还固定官方归档SHA-256、归档根、Node路径和可执行后缀。构建宿主必须与目标操作系统一致，但同一宿主可构建另一CPU架构。

### 3. Payload只是平台打包输入

每次命令先清理并重建Git忽略目录：

```text
build/release/<version>/<target>/payload/
├── bin/codexhost[.exe]
├── libexec/codexhost-shim[.exe]
├── runtime/node[.exe]
├── app/host-runtime.mjs
├── app/renderer-extension.js
├── licenses/Node.js-LICENSE.txt
├── licenses/diff-LICENSE.txt
├── licenses/zod-LICENSE.txt
└── THIRD_PARTY_NOTICES.txt
```

构建脚本按固定路径复制并检查精确allowlist，不遍历复制`target`、`dist`或`node_modules`。失败可留下不完整的Git忽略构建目录供诊断；发布系统不维护旧目录备份、原子回滚、内部Manifest或Payload SHA清单。

### 4. Host Runtime与Node Runtime保持现有供应链约束

Host Bundle从`packages/host-runtime/src/release-main.ts`构建为Node 24 ESM单文件。esbuild metafile必须包含AppServerHost和PiAdapter，拒绝Claude Code、Anthropic、Gate、测试和未经审查的运行依赖。

Node Runtime只来自目标固定的Node.js 24.13.1官方归档。缓存和下载都重新计算SHA-256，使用宿主`tar`解包，只复制Node可执行文件和LICENSE，不回退到PATH、nvm或当前Node。

### 5. macOS使用标准App Bundle和ad-hoc签名

macOS脚本将Launcher放入`codexhost.app/Contents/MacOS/codexhost`，将其余Payload映射到`Contents/Resources/{libexec,runtime,app,licenses}`，并把第三方声明放入`Contents/Resources`。Launcher同时保留普通`<root>/bin`布局解析。

脚本生成固定`Info.plist`，先签名Node、Shim和Launcher，再ad-hoc签名App，使用`codesign --verify --deep --strict`验证。随后把App和指向`/Applications`的符号链接放入临时目录，使用系统`hdiutil`生成并验证`codexhost-<version>-<target>.dmg`。首版没有品牌图标时允许使用系统默认App和磁盘图标。

### 6. Windows使用WiX Toolset 4 MSI

WiX源码显式声明九个Payload文件、per-user安装目录、开始菜单快捷方式、卸载注册和固定UpgradeCode。PowerShell脚本把目标映射到WiX `x64`或`arm64`，直接调用固定版本WiX 4 CLI生成`codexhost-<version>-<target>.msi`。

MSI不内置官方Codex Desktop、Pi或构建工具，也不要求管理员权限。后续Authenticode可作为artifact生成后的独立步骤增加，不改变Payload或WXS所有权。

### 7. 点击启动默认选择Pi，显式CLI保持兼容

安装快捷方式和Finder启动都不携带参数。Launcher无参数时等价于`codexhost launch --agent pi`，使安装后的主入口可用。`inspect`、显式`launch --agent codex|pi`和开发路径覆盖保持不变。

### 8. Release Workflow使用真实操作系统Runner

GitHub Release和手动触发均运行四目标矩阵。macOS arm64与x64使用对应原生Runner；Windows x64与arm64在Windows Runner使用对应Rust target和WiX架构。Windows arm64可以在同操作系统交叉构建，但这不替代原生ARM Runtime验证。Workflow只上传最终安装artifact与SHA旁车。

### 9. 最终artifact才有发布哈希

构建入口只对`.dmg`或`.msi`计算SHA-256，并写同名`.sha256`旁车文件。平台脚本必须验证DMG或MSI已生成且非空；真实Desktop Gate继续产生独立验证记录，不由文件生成自动升级为supported。

## Risks / Trade-offs

- [Apple App和DMG格式细节由项目维护] → 固定最小Info.plist、标准目录和Applications链接，使用系统`plutil`、`codesign`、`hdiutil`实际验证。
- [WiX 4语法或ARM64行为只在Windows可验证] → WXS保持显式小文件，在真实Windows x64/arm64 Runner分别构建；macOS不伪验证。
- [官方Node归档不可用或被替换] → 固定版本和SHA-256，缓存也重新校验，不回退本机Node。
- [脚本失败覆盖上次中间目录] → 中间目录全部Git忽略且不作为交付物；最终上传只消费本次命令成功返回的artifact。
- [无证书macOS首次启动被Gatekeeper拦截] → 发布说明明确首次放行步骤；不伪称已公证。
- [无参数默认Pi改变CLI行为] → 只改变过去无效的无参数调用；全部显式命令保持兼容并增加测试。

## Migration Plan

1. 更新Launcher标准Resources布局和无参数启动行为。
2. 将仍需要的目标、Node、Bundle、许可证和allowlist逻辑迁入`scripts/release/`，测试迁入`tests/release/`。
3. 删除`packages/release-staging`、Project Reference和Workspace锁文件条目。
4. 加入macOS App/DMG脚本并在当前宿主生成arm64与x64产物。
5. 加入WiX 4源码和PowerShell脚本；在真实Windows宿主分别生成x64与arm64 MSI。
6. 只为最终artifact生成SHA-256，更新验证记录和独立安装包进展。

回滚时删除新发布脚本和根命令并恢复Launcher无参数行为；现有普通Workspace构建和显式开发覆盖不受影响。

## Open Questions

首个非零产品版本、品牌图标、根LICENSE、发布签名证书和真实Windows构建宿主仍待确定。这些不阻塞生成结构有效的未签名首版安装产物。
