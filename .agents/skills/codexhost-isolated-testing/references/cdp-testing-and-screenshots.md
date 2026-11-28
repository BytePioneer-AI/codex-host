# CDP 自动化测试、确定性造数与 UI 截图参考

配合隔离 Web（如 `http://127.0.0.1:4401`）使用，全程零侵入用户日常环境。

## 1. 启动独立 Chrome（带 CDP）

使用独立的 `--user-data-dir` 与空闲 `--remote-debugging-port` 启动 Chrome，避免复用或污染用户日常浏览器：

```bash
DEMO_DIR=/tmp/codexhost-try
CDP_PORT=63401

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$DEMO_DIR/chrome-profile" \
  --remote-debugging-port="$CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1440,900 \
  "http://127.0.0.1:4401" >/dev/null 2>&1 &
CHROME_PID=$!
```

通过 `http://127.0.0.1:$CDP_PORT/json/list` 获取页面 `webSocketDebuggerUrl` 后，即可使用原生 Node `WebSocket`（Node 22+ 内置）发送 CDP 命令，无需额外安装 Playwright/Puppeteer。

## 2. 视口、主题与语言矩阵

- **桌面端视口**：`Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })`
- **手机端视口**：`Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true })`
- **亮暗主题**：结合 `Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'dark' | 'light' }] })` 与页面内主题设置（如 `localStorage` / 设置开关），避免只改媒体查询而页面显式主题未切换。
- **截图命令**：`Page.captureScreenshot({ format: 'png' })`，建议按 `raw-<feature>-<zh|en>-<light|dark>.png` 命名存入 `$DEMO_DIR`。

## 3. 确定性造数（CDP 网络层拦截）

不要在页面内 monkey-patch `window.fetch`（容易被已绑定的模块闭包或缓存绕过）。改用 CDP `Fetch.enable` 在网络层拦截，命中的接口返回确定性 JSON，其余全部 `Fetch.continueRequest` 放行。

codexhost Web UI 有两类常见 RPC 传输路径与信封格式，拦截前先核对 `apps/web-ui` 对应 client 调用路径：

1. **CH Web 统一 RPC**：`POST /api/ch/v1/rpc`（如 `codexhost/usage/statistics/get`）
   - 请求体包含 `method` / `params`
   - 响应信封：`{ "result": <payload> }`
2. **CodexHost 直连 RPC**：`POST /api/codexhost/<method>`（如 `POST /api/codexhost/remote-peers/list`）
   - 响应信封：`{ "result": { "ok": true, "value": <payload> } }`

最小拦截骨架（Node 22+ ESM）：

```js
await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*/api/ch/v1/rpc*', requestStage: 'Request' },
    { urlPattern: '*/api/codexhost/remote-peers/list*', requestStage: 'Request' },
  ],
});

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = msg.params;

  if (request.url.includes('/api/codexhost/remote-peers/list')) {
    const body = JSON.stringify({ result: { ok: true, value: { peers: mockPeers } } });
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(body).toString('base64'),
    });
    return;
  }

  await send('Fetch.continueRequest', { requestId });
});
```

## 4. 交互与截图避坑清单

- **清空富文本输入框（Lexical / ProseMirror）**：不要依赖 `document.execCommand('delete')`（常被编辑器状态机忽略导致文本叠加）。聚焦后使用 CDP `Input.dispatchKeyEvent` 发送全选与删除：
  - macOS 全选：`keyDown` / `keyUp`，`key: 'a'`，`code: 'KeyA'`，`modifiers: 4`（Meta）
  - 删除：`keyDown` / `keyUp`，`key: 'Backspace'`，`code: 'Backspace'`
- **去焦点框与等稳定**：截图前执行 `document.activeElement?.blur()` 避免按钮或标题残留焦点外框；等待 `document.fonts.ready` 与 300–500ms 让图表/动画/布局落稳后再截。
- **隔离测试仓库**：涉及 Git Diff、工作区或文件树的测试，在 `$DEMO_DIR/repo` 新建临时 git 仓库并造好改动，不要污染真实工作树。
- **强制肉眼验图**：每次截图完成后必须用读图工具逐张检查：
  1. 暗色与亮色模式下文字、胶囊、边框对比度是否清晰；
  2. 是否有文本截断、重叠、重复粘贴或残留焦点框；
  3. 是否泄露本机真实用户名、私有仓库名、Token 或内网地址（必要时脱敏或用临时目录名）。

## 5. 清理模板

```bash
kill "$CHROME_PID" 2>/dev/null || true
# 停掉本次启动的隔离 Web 进程与隔离 Host
target/debug/codexhost host stop \
  --node "$(which node)" \
  --host-runtime "$PWD/packages/host-runtime/dist/main.js" \
  --data "$DEMO_DIR"
rm -rf "$DEMO_DIR"
```
