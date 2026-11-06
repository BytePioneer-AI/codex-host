# Design

## Context

- `apps/web-ui/apps/web/public/sw.js` 目前只处理推送和通知点击，没有 `fetch` 处理。
- 每次界面启动时，`ui-codexhost` 都会调用 `ensureServiceWorker()`，注册范围为 `./`。登录页由 `auth.ts` 直接输出，不注册 Service Worker，所以只看过登录页的浏览器不会安装它。
- 已打开页面的“电脑离线”提示由 `auth-watch.ts` 探测 `/api/auth/status` 决定。
- 浏览器本地只保存草稿、视图选择和工作区排序等偏好。会话列表和历史都在内存中，没有可以离线浏览的内容。
- 项目只支持部署在站点根路径。

## Decisions

### 导航处理

- **处理范围：** `fetch` 事件只在 `event.request.mode === "navigate"` 时调用 `respondWith`，其他请求不调用，由浏览器照常处理。
- **请求方式：** 用 `fetch(event.request, { signal })` 发出原请求，保留原来的重定向语义，响应原样返回。不改用 `fetch(event.request.url)`，也不按 `response.ok` 判断，所以 302 和 401 登录页都不受影响。
- **10 秒超时：** 收到响应头前超过 10 秒，就取消请求，返回离线页；收到响应头后清除计时器。浏览器没有统一的导航失败时限，隧道丢包或连接卡住时可能等很久。
- **返回离线页的情况：** 抛出网络错误、超时，或响应状态为 502、503、504。离线页的响应状态为 503，`content-type: text/html; charset=utf-8`，`cache-control: no-store`。
- **不覆盖的情况：** 响应头已经返回后断流，以及 HTML 已返回但静态资源失败。这些情况交给浏览器和已有的连接提示处理。
- 不使用 Cache Storage，也不使用 navigation preload。

### 离线页

- **生成方式：** 一个完整的 HTML 字符串，由 `sw.js` 中的函数按语言生成。`navigator.language` 以 `zh` 开头时用中文，否则用英文。
- **内容：** 标题、说明、当前地址、“重试”按钮。
  - 页面内的脚本按 `navigator.onLine`，以及 `online`、`offline` 事件选择文案。
  - 浏览器报告离线时，显示网络已断开。
  - 否则显示“无法连接到电脑，请确认电脑开机且 Web 正在运行”。
  - `navigator.onLine` 只用来选择提示，不用来阻止请求。
- **自动恢复：**
  - 每 10 秒探测一次；页面重新可见、`online` 事件触发、点“重试”时立即探测。
  - 探测方式是 `fetch(location.href, { cache: "no-store" })`，带 5 秒超时。它不是导航，Service Worker 不处理。
  - 得到状态不是 502、503、504 的响应就 `location.reload()`。
  - 探测的是页面本身，所以不会出现接口通了、页面仍打不开而反复刷新的情况，是否开启认证也不影响。
  - 页面在后台时浏览器会放慢计时器，所以“约 10 秒内恢复”只针对前台页面。
- **通知点击：**
  - 现有的通知点击处理会向已打开的窗口发送 `codexhost/open-session`。
  - 离线页也接收这条消息，然后导航到 `./?session=<id>`。仍然离线时，Service Worker 在新地址上再显示离线页，恢复后打开该会话。
  - 离线页可见时，普通对话通知可能被当作“正在查看”而不弹出。这时电脑本来就离线，发不出推送，所以接受这一点。
- **样式：** 内联 CSS，适配浅色和深色主题（`prefers-color-scheme`），在手机宽度下排版正常。
- **页面限制：** 不加载外部资源。

### 更新与生效

- 已安装的 `skipWaiting` 和 `clients.claim` 保持不变。新版 `sw.js` 成功安装并激活后，离线页生效，与前端资源的版本无关。
- 开发模式的界面热重载只监视 shell 的 index，单改 `sw.js` 不会立即生效。开发时验证前，先确认新版 Worker 已激活。

## Risks / Trade-offs

- **[iOS Safari 清除 Service Worker]**
  - 在 Safari 中，网站七天内没有用户交互，Service Worker 注册可能被清除。
  - 添加到主屏幕的 Web App 不受这个七天限制，但用户清除数据或存储空间不足时仍可能被清除。
  - 主屏幕 App 和 Safari 标签页的数据是分开的，主屏幕 App 需要在线打开过一次。
  - 被清除后显示浏览器自己的错误页。这些情况写进用户文档。
- **[Cloudflare、nginx 等网关自带的错误页被离线页替代]** → 只替代导航请求，而且这几个状态码对用户的含义都是“到不了电脑”。
- **[`navigator.onLine` 不准确]** 例如连着没有互联网的 Wi-Fi 时仍报告在线。这时页面显示“无法连接到电脑”，探测会继续进行。
- **[首次访问时电脑必须在线]** → Service Worker 的固有限制。

## Migration

无数据迁移。回滚：恢复 `sw.js`。浏览器检查到旧版本后，离线页随之移除。
