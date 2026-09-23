# Imported skill provenance

The following ten skills were copied from [zai-org/ZCode](https://github.com/zai-org/ZCode/tree/872ad960de7ec172591f7e1952f7849229f94521) at commit `872ad960de7ec172591f7e1952f7849229f94521` on 2026-09-21 and adapted for codexhost. This notice covers these imports, not the pre-existing codexhost skills or the repository as a whole.

| Local skill | Source path at that commit |
| --- | --- |
| agent-browser | `.agents/skills/agent-browser` |
| ai-elements | `.agents/skills/ai-elements` |
| architecture-governance | `.agents/skills/architecture-governance` |
| dep-refs | `.agents/skills/dep-refs` |
| dogfood | `.agents/skills/dogfood` |
| electron | `.agents/skills/electron` |
| feature-boundary-planner | `.agents/skills/feature-boundary-planner` |
| react-best-practices | `.agents/skills/react-best-practices` |
| control-browser | `apps/zcode-cli/packages/browser-use-plugin/skills/control-browser` |
| web-gui-tester | `apps/zcode-cli/packages/browser-use-plugin/skills/web-gui-tester` |

## Local adaptations

- All ten entrypoints carry an adaptation notice and contextual invocation metadata in `agents/openai.yaml`. Repository AGENTS.md routes tasks to them.
- Architecture governance uses codexhost's existing checker and public package contracts. ZCode-only policy references, its context-generation wrapper and module scaffold were omitted; implementation and contract references were adapted.
- Feature planning uses codexhost source entrypoints in place of the ZCode feature graph. Shared planning templates remain reference material.
- Reference tracing uses available symbol tools and repository searches instead of unavailable ZCode `dep:refs`/Knip commands.
- Browser control uses the current session's runtime. Electron, browser CLI, exploratory testing and GUI testing instructions include local tool routing and authorization context.
- AI Elements and React guidance is scoped to the actual target stack. Example snippets, rule documents, browser templates and applicable references retain their upstream contents unless a local adaptation is marked.
- Imported examples and references have whitespace normalized where needed; Markdown hard breaks are retained.
- The local React skill name matches its directory, `react-best-practices`; its source frontmatter used `vercel-react-best-practices`.

These imports do not install browser executables, MCP servers, frontend libraries, or ZCode's Agent runtime, and do not change codexhost's root license. Supporting files are development references rather than product runtime assets.

## Retained licenses and attribution

ZCode first-party material: Copyright 2026 Z.AI Co., Ltd. Licensed under Apache-2.0; see [the retained license](licenses/ZCode-Apache-2.0.txt). The source [NOTICE.md](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/NOTICE.md) distinguishes first-party material from independently licensed third-party software and assets.

ZCode's [THIRD-PARTY-NOTICES.md](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/THIRD-PARTY-NOTICES.md) attributes these upstream portions:

- **AI Elements:** Copyright 2023 Vercel, Inc.; Apache-2.0. The [original attribution](licenses/ai-elements.txt) is retained alongside the full Apache-2.0 terms. Upstream license reference: `vercel/ai-elements`, commit `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`.
- **agent-browser, dogfood and electron:** Copyright 2025 Vercel Inc.; Apache-2.0. See the [retained original license](licenses/agent-browser.txt). Upstream license reference: `vercel-labs/agent-browser`, commit `99c732c18810494593ead9dd96ab6f5f0c78b729`.
- **React Best Practices:** source frontmatter and the pinned upstream documentation declare MIT, with author metadata `vercel`. ZCode explicitly records that a complete original copyright/license notice was not obtained. That unresolved provenance is preserved here; no copyright holder or complete license notice is inferred. Its upstream reference is `vercel-labs/agent-skills`, commit `063bee94c3f4df8453406c830b0a7df0f2860278`.

The Vercel references above identify license evidence retained by ZCode; ZCode states that the original import revisions were not recorded. They must not be presented as proven revisions of every copied file.
