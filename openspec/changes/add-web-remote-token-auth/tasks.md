# Tasks

## 1. 服务端认证

- [x] 1.1 在 `packages/web-server` 实现 token 存储和凭据解析：命名 token、本机 token、最近使用时间、`0600` 文件权限、跨进程重新读取；移除 `--rotate-token`。验证：新增单元测试覆盖创建、名称校验、明文持久化与重新读取、仅哈希旧记录兼容、文件权限、另一进程删除后立即失效、已删除 token 不会复活。
- [x] 1.2 接入 HTTP 和 upgrade 入口：本机访问判断、`?token=` 只接受本机 token、`POST /api/auth/login`、`GET /api/auth/status`、可信代理、无效 Cookie 清除、失败限速，以及带 fragment 处理的中英文登录页。验证：新增 HTTP 测试覆盖 spec 中本机访问、本机 token、可信代理和限速的所有场景，现有 `packages/web-server/test` 中使用 `?token=` 和 Bearer 的测试保持通过。
- [x] 1.3 删除 token 时断开连接：登记 HTTP 响应和 upgrade socket，覆盖 `/api/remote.mux`、侧栏浏览器、`/api/ch/v1/events`，以及跨进程删除。验证：新增测试确认删除 A 后其连接关闭、B 不受影响，运行中的会话和终端不被停止。
- [x] 1.4 推送订阅关联 token，并丢弃无归属订阅。验证：扩展推送测试，覆盖删除 token 时删除订阅、重新提交时更新归属、`--no-auth` 下仍可订阅。

## 2. 管理接口和界面

- [x] 2.1 在 `shared-contracts` 定义类型，在 Web 服务实现 token 列表、创建、删除 RPC，创建结果包含可用的网络地址。验证：测试覆盖本机成功、非本机拒绝且不泄露信息、`--no-auth` 拒绝；`npm run lint` 通过边界检查。
- [x] 2.2 在 `ui-codexhost` 增加 token 管理设置分区（含中英文）：列表、创建后及后续查看、复制 token 和登录链接、删除确认、备用 token 提示、明文提示、非本机提示。验证：新增 Playwright 测试覆盖本机和非本机两种访问、刷新后查看和复制 token，以及手机宽度下的布局。
- [x] 2.3 页面连接断开时探测登录状态并进入登录页，已开启通知的浏览器在打开页面时重新提交订阅。验证：新增 Playwright 测试，覆盖在线删除 token、断开期间删除 token，以及服务不可达时不进入登录页。

## 3. 默认行为和基础保护

- [ ] 3.1 `preview-launch` 保持默认监听 `0.0.0.0`，支持传递 `--trusted-proxy`；网络地址和二维码不带 token，并输出明文提示。验证：更新 `preview-launch.test.ts`、`distribution/pack.test.ts`、`startup-display.test.ts`；`npm start web` 手动确认手机能用创建的 token 登录。
- [x] 3.2 所有响应增加 `nosniff`，确认文件接口和 HTML 预览符合隔离要求。验证：新增 HTTP 测试确认响应头，以及 `/api/file` 拒绝 HTML 和 SVG；Playwright 测试确认预览中的脚本无法读取同源接口。

## 4. 文档和验收

- [ ] 4.1 更新 `docs/product/standalone-web.md`、`packages/web-server/README.md`、`packages/web-server/scripts/pack.ts` 中的发行 README，并把实施计划阶段 1 的状态改为已完成。验证：文档与实现一致，`docs/index.md` 无需新增条目。
- [ ] 4.2 真机验收：iOS 和 Android 手机通过局域网用链接和手动输入登录、删除 token 后进入登录页、重新登录后恢复通知（局域网 HTTP 下无法验证的项目写明）。验证：记录每个平台的结果，未执行的项目不算通过。
