# Renderer brand assets

`codexhost-logo.png` is the 3:4 codexhost product logo used by the installer and
application branding. `codexhost-icon.png` is its square crop used for the
in-product brand mark.

`codex-agent.png` is the Codex App GA mark distributed with OpenAI's official
`openai.chatgpt` VS Code extension. It is bundled as a data URL so the Renderer
does not depend on a local extension path or a network request.

The Agent picker uses the official Pi mark from `https://pi.dev/logo-auto.svg`
and the Claude mark distributed in Anthropic's official `anthropic.claude-code`
VS Code extension as inline vector paths.

`codexhost-readme.svg` embeds `codex-agent.png`, `claude-agent.svg`, and
`pi-agent.svg` in a responsive vector composition. Its background is `#F2EDE7`.
The README references this SVG through HTML because GitHub strips inline CSS
background and border-radius declarations from Markdown HTML.

These product names and marks remain trademarks of their respective owners.
