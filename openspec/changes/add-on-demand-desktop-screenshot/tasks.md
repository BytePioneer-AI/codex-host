# Tasks

## 1. Native capture and authenticated delivery

- [x] 1.1 在 `crates/platform` 实现 Windows、macOS 主屏的单次 PNG 采集，并通过现有 Launcher 的一次性子命令输出受限图片；优先复用 XCap 的截图实现，依赖限定 Windows/macOS，不接入录屏或新增独立程序。显式处理主屏缺失、macOS 权限与 Windows 会话限制；PNG 编码成功不代替权限检查。Linux 返回不支持且不加载图形库。验证：主屏选择、结果限制和错误映射的聚焦 Rust 检查，Windows/macOS 编译检查和 Linux 依赖隔离检查；真实屏幕验证单独记录，不在普通测试中擅自拍摄用户桌面。
- [x] 1.2 在 `packages/web-server` 增加 `POST /api/desktop/screenshot`，沿用 Web 认证与同源校验，复用已有打包 Launcher 路径解析，不启动 Host 或调用 Harness。返回 PNG 字节和服务端记录的拍摄完成时间，不使用 base64 或可访问文件路径；设置禁止缓存，限制并发、执行时长和图片大小，处理取消与临时文件清理。验证：通过受控原生入口夹具检查成功取图、未认证/跨源请求不触发采集、超时与超限释放，避免新增大型测试框架。

- [x] 1.3 macOS 显式取图时正确处理系统权限申请结果；已获准则继续本次截图，仍未获准则复用平台 URL 打开能力尝试打开固定的录屏设置页，返回权限不足并显示中英文手动授权、重试提示，不新增接口、自动授权、轮询或重拍。验证：无真实 OS 副作用的权限分支测试、macOS 原生构建与手机提示回归；实际设置页跳转保留给用户点击验收。

## 2. Minimal preview UI

- [x] 2.1 在 `ui-codexhost` 复用 `conversation.input.right` 与已有预览扩展点加入「桌面截图」按钮及临时图片卡片，复用已有图片放大交互。卡片只提供拍摄时间、重新截图和关闭；使用中英文文案解释仅供查看和敏感信息。不修改草稿、不调用发送、不改变 Agent 状态。验证：聚焦浏览器检查覆盖点击才发请求、重复点击抑制、成功替换、失败保留旧图标识、关闭/切换后忽略迟到结果，以及手机宽度下可关闭和放大。

## 3. Packaging documentation and platform acceptance

- [x] 3.1 确保实际发行 Launcher 包含截图入口；仅为截图依赖补齐必要的原生构建和运行条件及随包许可文本，不增加新的远控进程或服务。同步 `docs/product/standalone-web.md` 及 `docs/index.md` 的相关描述，写明 Windows、macOS 的前提和限制及 Linux 暂不支持。验证：使用仓库现有打包/原生构建检查确认入口及依赖解析，不以仓库 node_modules 或开发终端环境代替发行环境。
- [ ] 3.2 按 diff 运行最小充分的类型、边界与针对性检查，并在可用环境中验证真实启动方式下的主屏选择、首次授权/拒绝、重复截图和失败恢复；记录 Retina/4K 单张图片体积。Windows、macOS 的编译检查、真实桌面验收和 Linux 依赖隔离检查分开报告，没有可用环境的项目明确列为未验证，不以模拟图或已有浏览器截图代替。验证：所有声明通过的检查有实际执行结果，截图内容不进入 Git、日志或 Thread 历史。

### Validation record

- 已通过：`npm run build:typescript`、`npm run build:web:ui`、`npm run typecheck`、`npm run lint`、改动文件的 Prettier 检查、`cargo fmt --all --check`、OpenSpec 严格校验。
- 已通过：macOS Launcher 构建，platform/launcher 的聚焦 Clippy，4 项截图 Rust 单测及 Launcher 参数拒绝测试；Windows platform 交叉编译检查；Linux Launcher 运行依赖树没有 XCap 或其图形采集依赖。完整 Windows Launcher 交叉编译受资源构建环境限制，未通过。
- 已通过：6 项 HTTP 聚焦测试，以及 390px 手机视口的预览、放大、保留草稿、失败保留旧图、取消和切换会话测试。页面使用明确标记的模拟图片，不作为真实桌面取图验收。
- 已通过：现有 Web pack 脚本将当前构建的 Launcher 打包到仓库外，在独立目录执行其帮助及截图参数拒绝检查；Web、Desktop Payload 与 npm 包均携带截图原生依赖许可清单，包含 XCap 在内的 Windows/macOS 共 61 个锁定包的上游许可文本，objc2 上游文档使用发布源码标明的 commit。两个发行测试文件共 70 项通过、1 项 Windows 专用测试在 macOS 跳过。没有启动或替换用户的 Web/Host 服务。
- 已通过：授权指引的中英文文案与手机浏览器回归；权限分支测试覆盖已授权不申请、不打开设置，申请获准继续取图，仍未获准只申请一次并打开设置一次，不实际触发系统权限或设置 UI。macOS 原生构建与聚焦 Clippy 通过。界面说明已尝试打开运行 Web 的电脑端录屏设置，按系统要求授权、重启后手动重试，并保留打开失败时的手动入口；Windows 不要求关闭 UAC。不保证拒绝后再次弹系统提示，不自动修改授权或重试。
- 3.2 待验收：单独调用本机 macOS 原生入口返回 `desktop-screenshot/permission-denied`；没有保存或展示桌面图片。授权后的真实主屏、后台/打包启动授权归属、重复取图与 Retina/4K 体积尚未验证；Windows 无真机交互桌面环境，安全桌面和实拍也未验证。保留此项未勾选，不自动修改系统权限或以模拟图片代替验收。
