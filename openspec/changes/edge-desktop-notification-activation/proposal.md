## Why

原生壳内开启通知后，通知由 WebView2 发出，Windows 弹窗显示 loopback origin，丢失用户正在使用的 Microsoft Edge 通知来源与旧版布局。用户明确要求继续由 Edge 订阅和显示通知，只在点击后唤起 CH 原生客户端，不能新开要求密钥的 Web 页面。

## What Changes

- 保留 Edge 的 Web Push 订阅、Service Worker `showNotification` 和系统弹窗，不引入原生 Toast、WebView2 仿旧样式或自定义协议主链路。
- Edge `notificationclick` 优先调用同源 `codexhost/desktopSessionActivate`；Web 服务验证本机直连、订阅归属和运行中的原生壳后，通过固定 argv 调用 `codexhost app --session <id>`。
- Launcher 与原生壳的单实例协议增加会话激活，已有窗口显示并定位会话；启动竞态下保存目标并在 Web ready 后打开。
- 原生壳不创建或自动续订 WebView2 推送订阅，通知管理引导到 Edge。无运行中的原生壳、远程请求、订阅不匹配或激活失败时保留现有 Web 点击回退。
- 移除此前未部署的 WebView2 长驻 port/ACK 回跳候选，避免维护两套通知来源与激活协议。

## Impact

影响 Web Service Worker、通知设置 UI、Web server 推送 RPC、Launcher `app` 命令、原生壳单实例激活及 `standalone-web` 文档。通知标题、正文、图标和 Edge 宿主不变；不改变 Harness、Turn 完成事件或远程通知内容。
