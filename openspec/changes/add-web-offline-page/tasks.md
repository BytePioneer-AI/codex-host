# Tasks

## 1. 离线页

- [ ] 1.1 在 `sw.js` 中增加导航处理和内置离线页，按 design 实现。

  验证：Playwright（Chromium）浏览器测试。
  - **测试服务器：** 用开启认证并已登录的测试服务器；现有夹具默认使用 `--no-auth`，需要显式开启认证。`localhost` 和 `127.0.0.1` 属于安全上下文，可以注册 Service Worker。
  - **开始前：** 等 `navigator.serviceWorker.controller` 存在，即 Worker 已接管页面。
  - **模拟方式：**
    - 网关状态用 `browserContext.route()` 拦截 Worker 发出的请求，不用 `page.route()`。
    - 连接卡住用一个接受连接但不响应的本机服务器，或在路由中不响应。
  - **覆盖：**
    - 停止 Web 后刷新，显示离线页。
    - 连接卡住 10 秒后显示离线页。
    - 离线页期间恢复 Web，页面自动进入界面。
    - 导航持续返回 503，而 `api/auth/status` 返回 200 时，页面不反复刷新。
    - 导航返回 502 时显示离线页；返回 302、401、404 时显示原响应。
    - `context.setOffline(true)` 时，离线页说明网络已断开。
    - 离线页期间，接口请求不经过离线页。
    - 离线页收到 `codexhost/open-session` 消息后，转到对应的 `?session=` 地址。
    - 已有旧版 Worker 的浏览器升级后，新版 Worker 接管。
    - 新开标签页也会显示离线页。
    - 手机宽度下排版正常。
- [ ] 1.2 真机验收（需要阶段 5 的真实中转）：Android Chrome、iOS Safari 标签页、iOS 主屏幕 Web App 各验证一次：经中转打开后关闭电脑上的 Web，再打开显示离线页，电脑恢复后自动进入界面。验证：结果记录在实施计划阶段 5 的验证范围中。

## 2. 文档

- [ ] 2.1 文档：
  - `docs/product/web-remote-access.md` 说明离线页、首次访问要求和 iOS 的限制。
  - 架构文档中“前端壳的离线缓存”改为内置离线页，并说明原因。
  - 实施计划阶段 5 更新这一项的状态。

  验证：文档与实现一致。
