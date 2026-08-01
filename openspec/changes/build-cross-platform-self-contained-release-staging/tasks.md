## 1. Launcher安装契约

- [x] 1.1 让Launcher从普通发布根解析随包Shim、Node和Host Runtime，并保留显式开发覆盖测试
- [x] 1.2 支持标准macOS`Contents/Resources`资源布局及带空格App路径测试
- [x] 1.3 让无参数Launcher默认执行`launch --agent pi`，保持显式CLI兼容

## 2. 共享Payload构建

- [x] 2.1 保留四目标注册表、宿主限制、Node.js 24.13.1官方归档和固定SHA-256
- [x] 2.2 保留只注册Pi的正式Host入口和拒绝Claude依赖的esbuild审计
- [x] 2.3 将必要构建逻辑迁移到`scripts/release/`，测试迁入`tests/release/`，删除`packages/release-staging`
- [x] 2.4 生成固定十文件Payload（含生产Desktop Controller）和第三方许可证，删除内部Manifest、Payload SHA及目录备份事务
- [x] 2.5 在根`package.json`暴露单一`release:package -- --target <target>`命令

## 3. macOS DMG

- [x] 3.1 增加标准App Bundle、Info.plist、ad-hoc签名及验证脚本
- [x] 3.2 使用`hdiutil`生成包含Applications拖拽入口的独立架构DMG，并只为DMG生成SHA-256旁车
- [x] 3.3 在当前macOS宿主生成arm64和x64 DMG，验证挂载布局、Mach-O架构、随包Node版本、签名和仓库外资源解析

## 4. Windows WiX 4 MSI

- [x] 4.1 增加WiX 4 per-user安装定义，显式安装固定Payload和开始菜单快捷方式
- [x] 4.2 增加Windows PowerShell打包入口及x64/arm64架构映射
- [x] 4.3 增加四目标Release Workflow，只上传最终安装artifact和SHA旁车
- [ ] 4.4 在真实Windows宿主生成并验证x64与arm64 MSI；缺少环境时记录阻塞且不得宣称支持

## 5. 验证与文档

- [x] 5.1 运行发布脚本单元测试、Launcher测试、Lint、类型检查和聚焦Rust检查
- [x] 5.2 更新验证结论和独立安装包构建进展，运行OpenSpec strict validation并核对生成目录保持Git忽略
