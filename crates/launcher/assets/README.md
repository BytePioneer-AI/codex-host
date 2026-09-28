# Application icons

`codexhost.png` is a 1024px render of the vector brand icon
`packages/renderer-extension/src/assets/codexhost-app-icon.svg`: a light gray
rounded tile with a charcoal C and center square. When replacing the brand
artwork, edit the SVG and re-render this PNG from it.

macOS packaging creates its ICNS sizes directly from this PNG. Windows launchers
and the Inno Setup installer use `codexhost.ico`, with 16, 24, 32, 48, 64, 128,
and 256 pixel PNG frames. The uninstall listing uses the launcher icon.

After changing the PNG, regenerate the ICO on macOS:

```sh
node scripts/release/generate-brand-icons.mjs
```
