## 1. 替换未部署的 WebView2 回跳候选

- [x] 移除长驻 port、ACK 和 WebView2 通知来源逻辑，保留可复用的 pending session 与窗口激活部分。

## 2. Web server 激活 RPC

- [x] 新增窄 `desktopSessionActivate`，校验本机认证、endpoint owner、sessionId 和存活的原生壳记录。
- [x] 通过固定 argv 与显式数据目录调用 Launcher；覆盖本机接受、无壳回退、远程/错误 owner 拒绝测试。

## 3. Launcher 与原生壳

- [x] `app --session` 和单实例 `ShowSession` 复用现有激活通道，覆盖已有实例、冷启动及 pending session。
- [x] live 页面复用页面内会话导航；重连后消费最新目标。

## 4. Service Worker 与通知设置

- [x] Edge notificationclick 优先 RPC，成功后不开浏览器，未接受时保留原回退。
- [x] 原生壳不注册/恢复 WebView2 订阅并清理已有订阅，设置入口引导到 Edge；普通 Edge 通知管理不变。
- [x] 添加聚焦 SW/RPC/设置逻辑测试，不写浏览器、e2e 或 component 测试。

## 5. 文档与验证

- [x] 更新 `standalone-web` 的现行通知来源、点击目标和限制，不写过程记录。
- [x] 运行受影响测试、必要的跨包类型检查及 `openspec validate edge-desktop-notification-activation --strict`。
- [x] 完成 Windows 隔离验收：CH 隐藏/最小化后激活、无 CH 时已登录 Web 回退、真实 Edge 订阅推送；PWA 恢复 CodexHost 顶栏和图标布局，未复现“通过 Microsoft Edge”页脚。远程/relay、macOS、Edge 完全退出及成功 Turn 自动触发推送未覆盖。
  - Windows 隔离实测：原生壳隐藏或最小化时，点击 Edge 通知会恢复并聚焦原生窗口、打开目标会话，不新增 Edge 页面。原生壳退出后，Edge 新开已登录的目标会话；首次加载短暂显示会话错误，约一秒后恢复。
  - Edge 真实推送样式对照：普通标签页的弹窗顶栏显示回环地址；通过现有 UI 安装 CodexHost PWA 并在 standalone 窗口订阅后，顶栏显示 CodexHost。弹窗保留左上小图标、右侧大图标、会话标题和「已回复」，本次未显示旧截图中的「通过 Microsoft Edge」。
  - 未真机覆盖：远程/relay 订阅隔离、macOS、Edge 完全退出后的通知投递，以及成功 Turn 自动触发推送。样式验收使用产品发送器经真实订阅投递带会话 ID 的测试载荷。
