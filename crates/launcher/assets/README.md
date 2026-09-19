# Application icons

`codexhost.png` is the selected high-resolution white tile with a charcoal C
and center square. Keep it byte-identical to the Renderer asset
`packages/renderer-extension/src/assets/codexhost-app-icon.png` when replacing
the brand artwork.

macOS packaging creates its ICNS sizes directly from this PNG. Windows launchers
and the Inno Setup installer use `codexhost.ico`, with 16, 24, 32, 48, 64, 128,
and 256 pixel PNG frames. The uninstall listing uses the launcher icon.

After changing the PNG, regenerate the ICO on macOS:

```sh
node scripts/release/generate-brand-icons.mjs
```
