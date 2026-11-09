# 界面扩展 UI 方案生成提示词

使用内置 imagegen 工具，参考当前界面截图与仓库中引入的 DSH 插件管理界面结构。产物为设计方案，不是官方界面的实际截图。

Use case: ui-mockup.
Create a high-fidelity desktop UI DESIGN PROPOSAL, not an official screenshot, showing how the supplied codexhost "界面扩展" settings page would look using the DSH plugin manager's existing list/detail design language.
Input image role: visual reference for the existing settings window, exact sidebar, typography, dark palette, and current installed plugin data. Preserve the overall settings modal with rounded corners, charcoal #29292b surface, near-black surrounding application, left settings sidebar, top left "设置", top right close X. Output one crisp landscape screenshot-style design at about 1600x1100. No camera angle, no desk, no annotations or watermarks.
Keep sidebar text exactly: 通用设置, 界面扩展 (selected), 连接设备, 连接, 资源管理, 账号, 用量统计, 更新, 关于. Use small monochrome outline icons and subtle rounded selected background.
Redesign only the content area, using the source DSH plugin manager's structure. Center a comfortably spaced content column. Top header: "界面扩展" in 20px medium white text, upper right a compact refresh icon button and white "+ 添加扩展" button. Under the title show this existing description in subdued 13px text, naturally wrapping to two lines if needed: "为 Web 添加 DSH 主题和面板。扩展对连接此 Web 服务的所有页面生效，安装后可在这里启用。" Include a small circled info icon beside the description; place the longer lifecycle help behind this icon rather than displaying a large paragraph.
Below a generous 32px gap, small section label "已安装" with muted count "4".
Show four light, borderless full-width list rows, NOT separate heavy bordered cards. Each row has a 48x48 softly outlined rounded square plugin icon at left; middle has a clear 14px medium plugin name and one single-line muted 13px metadata; right has one compact standard OFF switch (dark gray track, white knob on left). Rows have comfortable 16px vertical rhythm. Show a subtle hover background on the third row and a small unobtrusive chevron to indicate opening its detail page. No uninstall buttons on the list; source URLs belong to the subsequent detail page and are not shown in this list. Do not invent a right-hand detail drawer.
Exact list row text:
1. "@frostgao/dsh-theme-blackgold" and "1.0.0 · DSH · 已禁用", monochrome palette/sun icon.
2. "dsh-desktop-clock" and "1.0.2 · DSH · 已禁用", monochrome clock icon.
3. "dsh-whale-pet" and "0.1.1 · DSH · 已禁用", monochrome whale icon.
4. "@smalltailqwq/dsh-client-ui-skin-maid-atelier" and "0.1.9 · DSH · 已禁用", monochrome window/theme icon.
Do not invent functionality descriptions, official plugins, statuses, or download counts. Make the long fourth name fit the content width cleanly.
Below the list after a clear gap, keep the existing recovery links "打开恢复页面" and "仅使用内置扩展打开" in small subdued underlined text. Keep plenty of calm lower whitespace. Refined hierarchy, neutral colors, restrained hover treatment, pixel-sharp Chinese text, no gradients or glows. The design should clearly embody DSH: list for scanning, click through for full descriptions, sources and uninstall, subtle hierarchy and minimal chrome.
