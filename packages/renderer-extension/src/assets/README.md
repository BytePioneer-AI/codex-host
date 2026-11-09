# Brand assets

Only Codex and codexhost artwork is bundled into the Renderer. External Harness
artwork belongs to `packages/adapters/<id>/assets/`, is declared in each plugin's
manifest, and reaches the Renderer as a validated data URL in the Host directory.
The Renderer uses an image element, never inline plugin SVG.

`codex-logo.png` is the Codex X mark source; `codex-logo-transparent.png` removes
its white background, and `codex-logo-bright.png` uses the official bright blue.
`codex-agent.png` is the Codex App GA mark distributed with OpenAI's official
`openai.chatgpt` VS Code extension.

## Current CodexHost UI mark

The Desktop navigation rail uses `createRendererSettingsBrandGlyph` in
`settings/icons.ts`: the upright open C ring and centered solid rounded square
from `history/codexhost-rail-v1.svg`, without a plate. The original path, square
geometry and `12.8 12.2 40 40` viewBox are preserved; the ring stroke is 3.2 units
(1.6px at 20px, 1.76px at the rail's existing 22px size). Both shapes use
`currentColor`, following the native button's normal, hover and selected colors.
Native rail hover/selection backgrounds, update badges and accessibility are
unchanged. Web retains its colored otter variant; Harness identity artwork is unchanged.

The settings and standalone console headers share `renderer-brand-mark.ts`
and its stylesheet, using `codexhost-otter-color.svg` with the same original
geometry and deep-blue/green colors as Web. Dark preference adds a `#f4f5f7`
circular backing and scales the animal to 90%; light preference keeps the original
colored mark without a backing. Settings retains its 24px mark inside the existing
26px container; the console retains its 28px mark. Header text and native navigation
glyphs are unchanged.

`codexhost-otter.ts` retains the original option 05 otter silhouette.
Viewable otter SVG exports:

- [`codexhost-otter-light.svg`](codexhost-otter-light.svg): light-theme monochrome silhouette.
- [`codexhost-otter-dark.svg`](codexhost-otter-dark.svg): dark-theme two-tone silhouette.
- [`codexhost-otter-color.svg`](codexhost-otter-color.svg): colored mark shared by settings and console headers.
- [Web colored mark](../../../../apps/web-ui/packages/client/ui-brand-official/src/assets/codexhost-otter.svg): deep blue body and green module, without a surrounding plate.

The otter exports stay in sync with `codexhost-otter.ts`; focused icon tests
check their geometry and palettes. Rail tests check the CH geometry against the
historical reference.

## Historical CH marks (v1)

- `history/codexhost-rail-v1.svg`: the previous open C ring and center square,
  preserved with the rail's original geometry and stroke. The current rail reuses
  its geometry with a lighter stroke; this reference file remains unchanged.
- `codexhost-app-icon.svg`: the previous plated CH application mark, retained at
  its existing path for compatibility and historical reference. It is no longer
  used by settings, console, native application, or installer icons. Native PNG
  and ICO assets are generated from `codexhost-otter-color.svg`; see the
  [application icon instructions](../../../../crates/launcher/assets/README.md).

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
