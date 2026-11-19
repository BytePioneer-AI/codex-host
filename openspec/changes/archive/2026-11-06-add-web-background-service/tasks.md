# Tasks

## 1. Web 和 Host 的后台能力

- [x] 1.1 Web 增加后台模式：读取并校验 `service.json`、开始监听后写就绪记录、设置变更时以专用退出码退出。验证：`packages/web-server` 的单元和 HTTP 测试覆盖默认只监听本机、选项校验失败不覆盖已保存的值、`npm start web` 默认仍对外。
- [x] 1.2 Host 的 `/v1/shutdown` 返回运行中的任务数，`--stop` 输出结果；就绪记录增加版本。验证：`packages/host-runtime` 测试覆盖有任务、无任务，以及旧版响应不带任务数。

## 2. 原生命令

- [x] 2.1 Launcher 增加 Web 监管进程和 ensure、stop：独立的就绪文件和锁、停止标记、退避重启、启动失败不重试。验证：参照 `host_service_tests.rs` 的 Rust 测试，加一个用假 Web 脚本的集成测试，覆盖崩溃重启、启动失败、并发 ensure、stop 后不重启。
- [x] 2.2 增加 `codexhost web`、`stop`、`status`，并在 npm wrapper 中路由：选项传递、打开浏览器或输出链接、版本和安装位置不一致时重启；`stop` 按 GUI、Web、Host、远程服务、Broker、Console 的顺序关闭。验证：Rust 测试和 `smoke-npm-package` 覆盖无图形界面、端口占用、版本不一致、status 不含 token；手动确认 codexhost 拉起的 GUI 被关闭，用户自己打开的 Desktop 不受影响，停止后服务没有被重新拉起，其他电脑重新连接后远程服务恢复。 结果：用户在 macOS 实测通过，未分场景记录；Windows、Linux 未实测。
- [x] 2.3 `codexhost` 在后台拉起 Web；未安装 Desktop 时改为打开 Web；`CODEXHOST_WEB_SERVICE=0` 关闭该行为。验证：测试覆盖 Web 失败不阻止 GUI、未安装 Desktop 时不打开 Console；手动确认 GUI 已打开时切到现有窗口。 结果：用户在 macOS 实测通过，未分场景记录；Windows、Linux 未实测。
- [x] 2.4 登录后自动启动：三个平台的写入、删除、校验，以及运行时刷新。验证：`crates/platform` 的测试覆盖生成内容和命令行长度限制；在 macOS 实际重新登录一次，Windows 和 Linux 未实测的写明。 结果：用户在 macOS 实测通过，未分场景记录；Windows、Linux 未实测。

## 3. 发行和更新

- [x] 3.1 Web 进入 `prepare-payload` 和 `prepare-npm`：复用 `app/plugins`、裁剪 `node-pty`、不带 LibreOffice 引擎，并写入各平台引擎的官方地址和校验值。验证：`expectedPayloadPaths` 和发行测试更新；在干净目录从发行产物运行 `codexhost web`，能登录并打开 Web 终端；记录各平台压缩后体积。
- [x] 3.2 Office 组件按需下载：下载、校验、解压、并发合并和旧版本清理，以及页面的下载提示和自动重试。验证：用本地假源的测试覆盖成功、校验失败、网络失败后重试、并发只下载一次、离开页面不取消下载、完成后自动显示预览、Web 终端不继承 `NODE_PATH`；用发行产物实际预览一个 DOCX 和一个 PPTX，分平台记录。
- [x] 3.3 更新流程在安装前停止服务，重新拉起后输出被中断的任务数；后台准备阶段不影响服务。验证：`crates/updater` 和 `update-coordinator` 测试覆盖正常更新、安装失败，以及只下载时不停止服务。
- [x] 3.4 补齐常驻服务更新：共享 Host 统一更新协调和安装上下文，原生监管进程接管已准备请求；Web 可在无 Desktop 时更新，按原使用方式恢复并验证版本，失败后尽力恢复可用安装；页面断线后有界查询实际结果，不重发更新。验证：聚焦测试覆盖共享入口、并发互斥、原生交接、纯 Web 成功、安装与恢复失败、错误安装路径、页面断线重连与超时；在临时目录用假安装产物验证进程生命周期，未实测平台如实记录。

## 4. 界面

- [x] 4.1 连接设备页增加直连开关和自启开关，只在本机且后台模式时显示；更新“如何从其他网络连接”的文案，覆盖发行版的启动方式。验证：Playwright 覆盖切换后页面恢复、手机和前台模式不显示开关、手机宽度布局。
- [x] 4.2 一键开关 Tailscale Serve。验证：用假 `tailscale` 脚本的 HTTP 和 Playwright 测试覆盖开启、确认时已被占用、退出 0 但未生效、只移除根路径、非本机请求被拒绝。
- [x] 4.3 Host 增加打开连接设备页的接口，Codex 设置页增加按钮。验证：`renderer-extension` 和 `host-runtime` 测试覆盖 Web 未运行时先拉起、Host 不可用时的提示。

## 5. 收尾

- [x] 5.1 Windows 卸载程序停止服务、移除自启项并提示 Serve；`npm stop` 识别后台 Web，`npm start web` 遇到占用时不结束后台 Web；更新 `docs/product/standalone-web.md`、`docs/product/web-remote-access.md`、`docs/operations/codexhost-console.md` 和 npm README。验证：`tools/dev-desktop` 的测试，以及文档中的命令与实现一致。
