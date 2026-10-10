# CodexHost Web UI

Private browser workspaces imported from the MIT-licensed `deepseek-harness` 0.2.1-alpha.1 Web UI and the local `codexhost-web` fork. The import keeps the selected client plugins, their browser runtime and protocol dependencies, and local CodexHost/mobile changes. It does not include the upstream CLI, release machinery, independent agent execution, or a second Git repository.

The source roster is in `import-manifest.json`. `packages/` and `vendor/` are npm workspaces of the parent CodexHost repository; install dependencies once at that repository root. `npm run build:web:ui` compiles plugin factories with the imported CSS/module-loader preset and builds `apps/web` with Vite. `lib/` and `dist/` are generated and ignored. All Harness execution belongs to the parent repository's Adapters and Web Server, not these browser packages.

The `generated/remote.js` and matching declarations in selected packages are pinned DSH protocol codecs from the imported fork's generated Host descriptors. They are protocol source snapshots, not copies of Harness SDKs or bundled applications. Keep them aligned with the Web Server's DSH protocol compatibility layer; do not generate them from the Desktop Host. The full upstream frontend type-check and test programs are not imported yet; the current integration uses source compilation and the Web Server's browser regression tests.

The upstream MIT license is retained in `LICENSE`, framework package licenses remain under `vendor/`, and upstream dependency notices are retained in `THIRD_PARTY_NOTICES.md`. Local import adaptations include private npm manifests, source exports, the selected source build, and removal of the upstream standalone Web Worker preview entry. The root LGPL license does not replace these notices.

Navigation icons additionally vendor a small SVG-only subset of OpenAI's public [`@openai/apps-sdk-ui` 0.2.2](https://github.com/openai/apps-sdk-ui) under MIT; the copyright and permission text are retained in [OPENAI_ICONS_LICENSE.txt](OPENAI_ICONS_LICENSE.txt). `ui-primitives/src/icons/openai-glyphs.ts` preserves the published geometry and fill rules, while `openai.tsx` adapts sizing, current color and decorative accessibility to existing controls. These are the public OpenAI glyphs, not a copy of Codex Desktop's private application or animation assets; individual private Desktop variants may differ. Harness brand assets still come from the installed plugins.

See [the Web feature document](../../docs/product/standalone-web.md) for runtime isolation, commands and supported behavior.
