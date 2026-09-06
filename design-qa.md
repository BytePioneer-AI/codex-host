# codexhost Settings Modal Design QA

- Visual target: `/var/folders/0d/hh4p_gx94p78zvmvtgq7884w0000gn/T/codex-clipboard-665ffe30-607d-4f2d-b573-f62e63bce890.png` (Codex Desktop visual language).
- Prior implementation: `/var/folders/0d/hh4p_gx94p78zvmvtgq7884w0000gn/T/codex-clipboard-bb639760-feb2-47d7-9dd9-e10971b78113.png`.
- Final implementation: `/tmp/codexhost-settings-refined-matched-v2.png`.
- Same-size comparison: `/tmp/codexhost-settings-polish-comparison-v2.png`.
- Theme coverage: `/tmp/codexhost-settings-refined-light.png` and `/tmp/codexhost-settings-refined-dark-v2.png`.
- Viewport: 924 × 716 CSS px at device scale factor 2; prior and final captures are both 1848 × 1432 pixels.
- State: Settings → Connections → Local → Pi not installed.

## Full-view comparison evidence

The prior implementation used an 880 × 640 frame, 196 px sidebar, 14 px base type, 64 px connection rows, and multiple equally strong bordered surfaces. The final implementation uses an 840 × 600 frame, 184 px sidebar, 13 px base type, 52 px rows, quieter dividers, and a clearer list-to-detail hierarchy. At the same pixel dimensions the final modal has more breathing room around the frame and less visual weight inside it.

## Focused-region comparison evidence

The navigation, list header, selected Pi row, status labels, inspector header, install callout, and primary install action are legible in the full-resolution 1848 × 1432 comparison. The selected row remains discoverable while unselected row actions stay hidden until hover or keyboard focus, removing repeated blue download icons from the resting state.

## Findings and comparison history

- P1 fixed: theme isolation forced a separate dark visual system. The shell now inherits Codex's resolved `color-scheme`, with verified light and dark captures.
- P2 fixed in iteration 1: the modal, sidebar, navigation rows, headings, and controls were oversized relative to Codex Desktop.
- P2 fixed in iteration 2: the Connections page still had too many competing borders, heavy list rows, large logos, a nested bordered callout, and a full-width action. The final pass reduced row and icon dimensions, removed the callout border, made its CTA content-width, and softened the table header and dividers.
- P2 fixed in iteration 2: programmatic initial focus produced a blue outline that looked like a second selection state. Initial focus is retained for accessibility but uses `focusVisible: false`; keyboard focus-visible behavior remains.
- P3 accepted: codexhost keeps its product mark and a persistent settings header instead of copying Codex's application toolbar. This preserves product identity without changing the content hierarchy.

## Required fidelity surfaces

- Fonts and typography: system font stack retained; base UI type is 13 px, page title 18 px, and item labels use medium rather than heavy weight.
- Spacing and layout rhythm: frame, sidebar, header, rows, controls, cards, and gutters now use the denser rhythm visible in Codex Desktop.
- Colors and visual tokens: neutral selected states and subtle borders match Codex's light surfaces; semantic status colors and both themes remain distinct.
- Image quality and assets: existing source logo assets and the repository's icon library remain sharp at reduced sizes; no replacement or placeholder assets were introduced.
- Copy and content: all localized connection labels, status text, descriptions, and actions are preserved.

## Validation

- Primary interaction rendered: opening Connections, selecting Pi, and showing its installation detail.
- Theme states rendered: light and dark.
- Responsive risk checked at the modal's 924 × 716 CSS host viewport; no clipping or horizontal overflow was visible.
- Remaining P0/P1/P2 findings: none.

final result: passed
