# Application icons

`codexhost.png` is a 1024px render of the approved colored otter in
`packages/renderer-extension/src/assets/codexhost-otter-color.svg`, centered on a
light gray rounded tile with transparent outer corners. The native icon shares
the UI mark's geometry and deep-blue/green palette.

macOS packaging creates its ICNS sizes directly from this PNG. Windows launchers
and the Inno Setup installer use `codexhost.ico`, with 16, 24, 32, 48, 64, 128,
and 256 pixel PNG frames. Desktop and Start menu shortcuts, and the uninstall
listing, use the launcher icon.

After changing the otter artwork, regenerate both native assets from the vector
source using Playwright Chromium:

```sh
npx playwright install chromium
node scripts/release/generate-brand-icons.mjs
```

An installed Chrome or Microsoft Edge can also render the assets, for example:

```sh
node scripts/release/generate-brand-icons.mjs --channel msedge
```
