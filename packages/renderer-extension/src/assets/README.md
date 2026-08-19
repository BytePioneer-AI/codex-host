# Renderer brand assets

`codexhost-logo.png` is the 3:4 codexhost product logo used by the installer and
application branding. `codexhost-icon.png` is its square crop used for the
in-product brand mark. `codexhost-command-icon.png` is the 64-pixel derivative
used in the native Slash Command menu so the browser bundle does not inline the
full-resolution source for a 20-pixel surface.

`codexhost-logo-transparent.png` is the white-background-free square logo
extracted from `codexhost-logo.png`. `codex-logo.png` is the Codex X mark
source and `codex-logo-transparent.png` is its white-background-free square
variant. `codex-logo-bright.png` recolors that mark in the official bright
Codex blue so it stays visible on dark surfaces and is the Renderer settings
brand icon (settings header mark and the application-header settings trigger
button).

`codex-agent.png` is the Codex App GA mark distributed with OpenAI's official
`openai.chatgpt` VS Code extension. It is bundled as a data URL so the Renderer
does not depend on a local extension path or a network request.

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

`codexhost-readme.svg` embeds `codex-agent.png`, `claude-agent.svg`, and
`pi-agent.svg` in a responsive vector composition. Its background is `#F2EDE7`.
The README references this SVG through HTML because GitHub strips inline CSS
background and border-radius declarations from Markdown HTML.

These product names and marks remain trademarks of their respective owners.
