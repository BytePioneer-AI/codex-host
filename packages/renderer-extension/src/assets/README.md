# Renderer brand assets

`zcode-agent.svg` matches the ZCode Adapter's `assets/icon.svg`, preserved from
the upstream codex-host ZCode integration snapshot `b66013bb`. It is bundled as
a data URL and does not load an installed application asset at runtime.

`codex-logo.png` is the Codex X mark
source and `codex-logo-transparent.png` is its white-background-free square
variant. `codex-logo-bright.png` recolors that mark in the official bright
Codex blue so it stays visible on dark surfaces.

`codexhost-app-icon.svg` is the vector master of the codexhost brand icon: a
light gray rounded tile with a charcoal C and central rounded square, padded to
the macOS icon grid. It is the Renderer settings brand icon (settings header
mark and the application-header settings trigger button).
`crates/launcher/assets/codexhost.png` is a 1024px render of this SVG for macOS
application and DMG icons. Windows application and installer icons use the
multi-size `crates/launcher/assets/codexhost.ico` generated from that PNG.

`codex-agent.png` is the Codex App GA mark distributed with OpenAI's official
`openai.chatgpt` VS Code extension. It is bundled as a data URL so the Renderer
does not depend on a local extension path or a network request.

`omp-agent.svg` is the official OMP favicon mark from the Oh My Pi repository
(`packages/collab-web/public/favicon.svg`). `opencode-agent.png` is OpenCode's
square mark with its dark outer plate. Both are bundled locally so the Renderer
does not depend on a network request.

`kiro-agent.svg` is the unmodified official Kiro icon from
`https://kiro.dev/icon.svg`, bundled locally as a data URL.

`codebuddy-agent.svg` is the CodeBuddy mark provided as `10001.svg` from a
capture of `https://www.codebuddy.cn/`. The original purple background, white
mark, 40×40 viewBox and rounded clipping are preserved without modification.
It matches `packages/adapters/codebuddy/assets/icon.svg` byte for byte; both
copies are bundled locally so no network request is needed.

`workbuddy-agent.svg` is the WorkBuddy mark provided as `10001.svg` from a
capture of `https://www.workbuddy.ai/`. The original green gradient, yellow
glow, white mark, 130×130 viewBox and rounded clipping are preserved without
modification. It matches `packages/adapters/workbuddy/assets/icon.svg` byte
for byte, which is also used by the README capability table; both copies are
bundled locally so no installed application path or network request is needed.

`cursor-agent.svg` is the unmodified official Cursor Cube favicon from
`https://cursor.com/favicon.svg`, with its original 512×512 viewBox, dark rounded
plate and light mark. It matches `packages/adapters/cursor-cli/assets/icon.svg`
byte for byte; both are bundled locally without runtime network requests.
The README badge uses the matching standalone 2D Cube from the official brand
kit; source details are in `docs/harnesses/cursor/cursor-cli-experimental.md`.
`hermes-agent.png` is a cropped and resized copy of the Hermes Agent mark from
the official Hermes Agent website favicon. It is bundled locally so the
Renderer does not depend on the Hermes installation or a network request.

The Agent picker uses the official Pi mark from `https://pi.dev/logo-auto.svg`
and the Claude mark distributed in Anthropic's official `anthropic.claude-code`
VS Code extension as inline vector paths. The DeepSeek Harness whale mark is
the exact extract from the official `deepseek-harness` web favicon
(`packages/client/ui-primitives/src/FishLogo.tsx` in that repo), rendered
inline in the DeepSeek brand blue `#4D6BFE`. `grok-agent.png` is a cropped and
resized copy of the Grok mark served by `grok.com`, provided from a captured
first-party page asset so the Renderer does not make a network request. The
square source is stored with transparent rounded corners so the black plate
does not render as a hard square.

These product names and marks remain trademarks of their respective owners.
