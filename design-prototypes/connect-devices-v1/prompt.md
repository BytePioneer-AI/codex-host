# 最终生成提示词

工具：内置 imagegen。参考输入：用户提供的连接设备页截图。

Use case: ui-mockup.
Create ONE polished, practical, high fidelity desktop UI design review image for the codexhost “连接设备” settings page. Image 1 is a REFERENCE for existing functionality and the existing settings modal shell, not a request to reproduce the same cluttered page.
Output a single flat straight-on screenshot-like artboard at approximately 1600x1200 or taller if needed to show the entire page. Chinese Simplified text must be crisp, readable, and spelled correctly. No browser chrome, no device photograph, no 3D perspective, no annotations outside the app, no marketing illustration, no split-screen alternatives.

DESIGN REFERENCE:
Use the restrained visual language described by awesome-design-md's Vercel and Linear analyses: near-black/charcoal surfaces, quiet 1px borders, generous but purposeful spacing, compact navigation, strong information hierarchy, system sans-serif, and small neutral controls. Keep the familiar codexhost settings shell. This is a utilitarian settings page, not a landing page. No purple glow, no decorative gradients, no oversized buttons.
Colors: app background #111214, settings sidebar #202124, content #242528, inset cards #292a2e, fine borders #3a3b40, text #f2f2f4, secondary #a1a1ab. Use muted green only for enabled/connected indicators, and white/light-gray selection borders. Dark theme only.

SHELL INVARIANTS:
A rounded modal fills the artboard with a narrow margin. Left navigation ~220px wide stays familiar, with title “设置”, then line-icon items “通用设置”, “界面扩展”, “连接设备” (selected), “连接”, “资源管理”, “账号”, “用量统计”, “更新”, “关于”. Small close X upper right. Do not redesign other settings pages. No theme selection, no language selector on this page.

MAIN PAGE:
Clear page title “连接这台电脑”, subtitle “用手机相机扫码，在浏览器中继续使用。” Small green-dot status aligned top right “设备访问已启用”.
Use unmistakably separate, well proportioned sections with compact titles, coherent spacing, and restrained rounded bordered containers.

SECTION A: “扫码连接”
One top card, QR on the left and connection information to its right.
A clean black-and-white QR-like visual in a white square about 164px, with label “用手机相机扫码” underneath. QR is a non-functional design placeholder; never copy the real QR, credentials, IP addresses, device names, or domains from the reference.
Right side: small caption “当前连接方式”, selected route heading “中转访问”, small neutral pill “跨网络”, concise helper “手机无需额外安装应用”. Under it a tidy read-only link field showing ONLY fictional “demo.r.chost.example” and a separate compact “复制链接” button. Small muted note “请保持电脑唤醒且 Web 正在运行。” The QR, selected method and copied link must feel part of the SAME connected action.

SECTION B: “连接方式”
A clean bordered group of compact selectable rows, radio circles at left, title, short description, address as smaller monospaced secondary text. Layout aligned, no awkward empty areas.
Row 1: “Tailscale” with a subtle “推荐” pill; description “跨网络访问 · 手机需开启 Tailscale”; example “demo.ts.example”.
Row 2: “同一 Wi-Fi”; description “使用局域网地址，无需额外安装”; example “192.168.1.20:4400”.
Small expanded disclosure “其他连接方式” containing selected “中转访问” with example “demo.r.chost.example”, then unselected “虚拟网络” with “192.168.64.2:4400”. The selected radio and border agree with “中转访问” in the QR card. These two advanced rows can be visually nested and compact. All addresses are fictional examples.

SECTION C: “访问管理”
A bordered card of three clear horizontal rows separated by hairlines.
1. “中转访问” title with a small green “已开启” indicator, muted description “通过中转地址连接这台电脑”. Right aligned compact “刷新状态” button plus an enabled neutral/white switch. Below the copy a quiet collapsed disclosure “地址与身份说明”. Do NOT display a filesystem path or a long explanation about identity keys in the normal layout.
2. “访问令牌” with muted description “连接设备时用于身份验证”. Two small right aligned outlined buttons “复制令牌” and “重新生成”. Never show an actual token.
3. “登录后自动启动” with short muted description “电脑登录后启动 Web 服务”, right aligned enabled switch.
Below this group, a simple lower-priority row “停止设备访问”, subtle helper “其他设备会断开，运行中的任务继续。”, and a small muted red outlined button “停止访问…”.
At the bottom a quiet collapsed help row “连接遇到问题？” with chevron.

CONSTRAINTS:
Preserve actual product concepts: Harness, Host, connection route and account must not be conflated. Do not add invented features such as connected-device inventory, pairing approvals, online user avatars, device names, connection-speed metrics, or account login. This is a visual proposal only, no claim of functional QR or active connection.
Deliver one complete well aligned artboard, all sections fully visible, with sufficient density to fit and legible Chinese text. Use the reference's page content as the starting point while substantially improving grouping, hierarchy, and scannability.
