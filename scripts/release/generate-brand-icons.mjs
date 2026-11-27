// Generate native PNG and Windows ICO assets from the coastal wave badge app icon SVG.
// Usage: node scripts/release/generate-brand-icons.mjs [--channel chrome|msedge]
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { channel: { type: "string" } } });
const assets = path.resolve(import.meta.dirname, "../../crates/launcher/assets");
const desktopIcons = path.resolve(import.meta.dirname, "../../apps/desktop-shell/src-tauri/icons");
const source = await readFile(
  path.resolve(
    import.meta.dirname,
    "../../packages/renderer-extension/src/assets/codexhost-app-icon.svg",
  ),
  "utf8",
);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch({ channel: values.channel });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  body > svg { display: block; width: 100%; height: 100%; }
</style>
${source}`);
  await page.setViewportSize({ width: 1024, height: 1024 });
  await page.screenshot({ path: path.join(assets, "codexhost.png"), omitBackground: true });
  const images = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    images.push(await page.screenshot({ omitBackground: true }));
  }
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let index = 0; index < sizes.length; index += 1) {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index] % 256;
    directory[entry + 1] = sizes[index] % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  const ico = Buffer.concat([directory, ...images]);
  await writeFile(path.join(assets, "codexhost.ico"), ico);
  await writeFile(path.join(desktopIcons, "icon.ico"), ico);
} finally {
  await browser.close();
}
