# Pet Companion

宠物伙伴默认使用内置 CodexHost 水獭，也可以从 Codex Pets、Petdex 与 CodexPets.net 在线市场下载形象。桌面端显示独立透明置顶浮窗；Web 端在当前 CodexHost 页面有待处理通知时显示宠物头像，确认通知或切走页面后恢复原图标。偏好设置与收藏保存在共享 Host，浮窗显示在 Host 所在电脑。

Pet Companion starts with the built-in CodexHost Otter. The Desktop build opens a transparent always-on-top window, follows the shared Host task summary, and keeps the pet visible while CodexHost is minimized or another application is active. The Web entry contributes the pet avatar to the current CodexHost tab only while unread attention is present; switching away or acknowledging the notice restores the original favicon.

The page connects to three public catalogs:

- [Codex Pets](https://codex-pets.net/)
- [Petdex](https://petdex.dev/)
- [CodexPets.net](https://codexpets.net/gallery)

The sole bundled character is the official CodexHost otter, reused from `packages/renderer-extension/src/assets/codexhost-otter-color.svg` and the interior backing in `codexhost-otter-dark.svg` under this repository's LGPL-3.0-only license. Its vector silhouette and brand colors are preserved, with a light interior for dark-background legibility. The shared renderer adds breathing, work bobbing, an expectant tilt, a completion bounce, and a brief error shake. Reduced-motion preferences suppress movement. It works offline, stays available in the collection, and does not consume the 64 downloaded-pet slots. Removing the selected market pet restores the otter; the page also offers **Restore default otter**. Existing market selections survive upgrades.

Market downloads are checked as image-only PNG/WebP ZIP packages, stored in the Host data directory, and kept with the market author, source, and supplied license text. The built-in vector renderer is not available to downloaded archives. A market entry that does not declare a license is shown as such.

## Install

1. Build `pet-companion.zip` with `node tools/package-pet-companion.mjs` from the repository root.
2. In Desktop, open **Settings → Plugins**, choose **Import**, select the ZIP, then enable **Pet Companion**.
3. In Web, open the **Plugins** workspace, choose **Import**, select the ZIP, then enable **Pet Companion**. Open its page from the top page switcher after it is enabled.
4. The default otter starts the Desktop window automatically when the native shell is available. Open the page to adjust preferences or download and select a market pet.

The extension needs a Host that exposes the activity summary, managed native windows, and owned tab-icon contributions. An older Host reports a missing activity service; a Host without a desktop shell keeps the page and Web avatar available and marks native windows as unavailable.

Hover the Desktop pet to see the CodexHost task center. Running, waiting and unread counts stay above a compact session list. Each row shows the actual Agent's icon and name alongside the title, project and state, reusing installed Harness artwork with a generic fallback when unavailable. Waiting sessions appear first. Selecting a row opens the corresponding Web session on the Host computer. A header control switches to window preferences, including size, hover expansion, status visibility and position locking. The panel follows the native shell's white/slate surfaces and teal accent; the transparent background stays click-through. The bundled Codex icon matches the Web sidebar's official Codex App mark.

Agent coverage follows the installed CodexHost session adapters. Icons are resolved by each session's actual Harness ID rather than a fixed list of Agent names, so newly installed adapters with artwork are supported automatically. Usage-only plugins do not represent session Agents.

会话图标覆盖 CodexHost 安装的全部会话 Agent，按会话实际使用的 Agent 匹配宿主图标。后续新增适配并提供图标后，宠物面板会自动支持；仅提供用量统计的插件不计为会话 Agent。

中文导入路径：Desktop「设置 → 插件 → 导入」或 Web「插件 → 导入」，选择 ZIP 并启用，默认水獭即可使用。Web 可以从插件工作区顶部切页栏打开「宠物伙伴」；进入市场下载一只宠物后，会自动选中，也可以恢复默认水獭。桌面浮窗的启动需要本次新增的 Host 服务和桌面壳，旧版宿主单独导入 ZIP 不具备这些能力。

## Publish

Create a GitHub repository or branch containing the extension source and the generated ZIP. Attach the ZIP to a GitHub Release so users can import the immutable artifact. Keep `manifest.json` at the ZIP root and include the market URLs, source links, and supplied license information in the release notes. Do not publish downloaded pet archives inside this repository.
