# Tasks

## 1. Serve 状态和信任

- [x] 1.1 在 `shared-contracts` 增加 Tailscale 状态和新地址种类；在 `web-server` 只读获取 Tailscale 状态、Funnel 标记和占用目标。验证：单元测试覆盖未安装、未运行、未登录、无 HTTPS、未转发、占用、已转发、Funnel 和超时，并确认不调用写入命令；`npm run lint` 通过边界检查。
- [x] 1.2 让回环地址的信任跟随 Serve 状态刷新。验证：用放在 `PATH` 最前的假 `tailscale` 脚本做 HTTP 测试，覆盖检测到转发后 Cookie 带 Secure、按 `x-forwarded-for` 分别限速、转发撤销后恢复忽略、未检测到时伪造的头被忽略、经 Serve 的请求始终不算本机。

## 2. 地址和启动

- [x] 2.1 增加 `--public-url` 和 `CODEXHOST_WEB_PUBLIC_URL`，由 `preview-launch` 传递，并在启动输出加入公开、Funnel 和 Serve 地址。验证：更新 `preview-launch.test.ts`、`startup-display.test.ts`、`network-urls.test.ts`，覆盖地址校验失败、排序、Tailscale 超时不阻止启动、第一行格式不变；发行 README 同步更新。

## 3. 界面

- [x] 3.1 在连接设备页显示 Tailscale 状态和下一步提示，增加可复制的开启命令以及公开和 Funnel 地址标记（含中英文）。验证：Playwright 配合假 `tailscale` 脚本覆盖各状态、占用时不显示命令、已转发时默认选中 HTTPS 地址，以及手机宽度下的布局。
- [x] 3.2 增加“电脑离线”状态和探测超时。验证：扩展 `ch-mobile-connection.test.ts`，覆盖持续不可达才提示、短暂中断不提示、探测 200 时显示正在重连、502 归为电脑离线、恢复后提示消失且草稿保留。
- [x] 3.3 在连接设备页增加默认收起的“如何从其他网络连接”，介绍 Tailscale 和自备隧道（含中英文）。验证：Playwright 覆盖默认收起、展开后的链接和手机宽度下不横向溢出。

## 4. 文档

- [x] 4.1 新增 `docs/product/web-remote-access.md`，更新 `docs/index.md`、`docs/product/standalone-web.md`、`packages/web-server/README.md`。验证：文档参数与实现一致；nginx 和 frp 示例能在本地跑通的就实际运行，未运行的在文档中标明。
