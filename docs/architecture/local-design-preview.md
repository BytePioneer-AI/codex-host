# 本地设计预览

`codexhost preview open <file>` 让任一 Harness 的 Thread 把本地 HTML（例如 `.spec/mockups/` 中的设计稿）显示在 Codex 内置浏览器里，并在文件变化后自动刷新。实现位于 `packages/host-runtime/src/local-preview.ts`，行为契约见 `openspec/changes/add-local-design-preview`。

## 服务

- 每个预览一个只读 HTTP 服务器，监听 `127.0.0.1` 的随机端口，根目录是目标文件所在目录。Codex 只打开 loopback 根地址，所以目标文件本身在 `/` 提供，相对路径的样式、脚本和图片按该目录解析。
- 只接受 `GET`/`HEAD`；不提供目录列表；解码后的路径与 `realpath` 都必须留在根目录内，路径穿越、空字节和指向目录外的符号链接返回 404。
- 目标文件必须位于调用方的工作目录内（同样按 `realpath` 比较）。CLI 在调用方一侧把相对路径解析为绝对路径，并传入调用方的 cwd 与 Thread 标识。
- HTML 响应在 `</body>` 前注入一段脚本，订阅 `/__codexhost_preview/reload`（SSE）。递归监听根目录，300 毫秒内的连续变化合并为一次刷新。刷新脚本只注入预览服务器自己的响应，不进入 Codex 聊天页。

## 打开方式

1. 通过已有的本地页面通道（`createLocalPageOpener`，与 ZCode 验证页相同）在内置浏览器的后台标签打开，挂在当前可见的本地任务下并 `show()`。同一文件再次打开时复用已有预览；标签被用户关闭后，`show` 会重新打开。
2. 内置浏览器不可用（例如没有可见的本地任务）时，经 Launcher 在系统浏览器打开，结果为 `opened: "systemBrowser"` 并附原因。
3. 两者都没有（受管远程 Host）时返回 `UNSUPPORTED` 与文件路径。

## 生命周期

`preview list|show|close` 管理已打开的预览。Desktop 归档 Thread 时（`thread/archive`），该 Thread 打开的预览关闭；Runtime 退出时全部关闭。每个 Runtime 最多同时 8 个预览，超出时关闭最久未使用的一个。预览只存在于 Runtime 生命周期内，不持久化。
