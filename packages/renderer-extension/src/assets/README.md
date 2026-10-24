# Brand assets

Only Codex and codexhost artwork is bundled into the Renderer. External Harness
artwork belongs to `packages/adapters/<id>/assets/`, is declared in each plugin's
manifest, and reaches the Renderer as a validated data URL in the Host directory.
The Renderer uses an image element, never inline plugin SVG.

`codex-logo.png` is the Codex X mark source; `codex-logo-transparent.png` removes
its white background, and `codex-logo-bright.png` uses the official bright blue.
`codex-agent.png` is the Codex App GA mark distributed with OpenAI's official
`openai.chatgpt` VS Code extension.

## CodexHost UI mark

`codexhost-otter.ts` contains the vector silhouette of an otter holding a module.
The navigation rail renders it inline without a plate: `currentColor` in light UI,
and a neutral two-tone palette in dark UI (body/module `#697680`, face/chest
`#b8c0c6`). CSS `light-dark()` follows the inherited native color scheme without
additional theme state. Native rail hover/selection backgrounds and update badges
are preserved; Harness identity artwork is independent of the product mark.

Settings and standalone console headers share `renderer-brand-mark.ts` and its
stylesheet. They use `codexhost-otter-color.svg`: a deep-blue `#082e59` body and
green `#19a785` module. Dark preference adds a `#f4f5f7` circular backing and scales
the animal to 90%; light preference has no backing. Settings uses a 24px mark
inside its 26px container; the console uses a 28px mark.

Viewable SVG exports:

- [`codexhost-otter-light.svg`](codexhost-otter-light.svg): light-theme monochrome silhouette.
- [`codexhost-otter-dark.svg`](codexhost-otter-dark.svg): dark-theme two-tone silhouette.
- [`codexhost-otter-color.svg`](codexhost-otter-color.svg): colored settings and console mark.

Keep these exports aligned with `codexhost-otter.ts`; focused icon tests check
geometry and palettes against the inline paths.

## Historical CH marks

- [`history/codexhost-rail-v1.svg`](history/codexhost-rail-v1.svg): open C ring and
  center square, retained as a reference rather than used in the UI.
- `codexhost-app-icon.svg`: plated CH application mark. The launcher PNG and
  Windows ICO remain derived from this asset; native application and installer
  icons are independent of the UI mark.

## External artwork provenance

- Pi: official `https://pi.dev/logo-auto.svg`. The original Renderer paths, viewBox
  and `currentColor` SVG rendering are preserved in the plugin Manifest; the original
  standalone image resource is unchanged. No light plate is added.
- Claude Code: Anthropic's official `anthropic.claude-code` VS Code extension.
- DeepSeek Harness: official web favicon / `FishLogo.tsx`, blue `#4D6BFE`.
- OMP: Oh My Pi `packages/collab-web/public/favicon.svg`.
- OpenCode: official square mark with dark outer plate.
- Grok: cropped first-party `grok.com` mark with transparent rounded corners.
- Kiro: official `https://kiro.dev/icon.svg`.
- CodeBuddy and WorkBuddy: captured first-party `10001.svg` assets; original
  backgrounds, marks, viewBoxes and clipping are preserved.
- Cursor: official `https://cursor.com/favicon.svg` Cube with its dark plate.
- Hermes: the original cropped/resized website favicon, unchanged; its existing light plate,
  padding and rounded corners are declared by the plugin rather than baked into the artwork.
- ZCode: upstream codex-host integration snapshot `b66013bb`.

Product names and marks remain trademarks of their respective owners.
