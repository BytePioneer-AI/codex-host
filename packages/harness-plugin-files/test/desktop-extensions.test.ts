import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { desktopExtensionManifestSchema } from "@codexhost/shared-contracts";
import { expect, it } from "vitest";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYQAAAAASUVORK5CYII=",
  "base64",
);

it("packages nested logos and screenshots and rejects invalid image bytes before publishing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-extension-build-"));
  try {
    const icon = "images/logo.png";
    const screenshot = "images/sidebar.png";
    const source = path.join(directory, "source");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(source, "images"));
    await writeFile(
      path.join(source, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        desktopApi: 1,
        id: "gallery",
        name: { en: "Gallery", "zh-CN": "图库" },
        version: "1.0.0",
        description: { en: "Sample gallery", "zh-CN": "示例图库" },
        desktop: { script: "desktop.js" },
        icon,
        screenshots: [screenshot],
      }),
    );
    await writeFile(path.join(source, "src", "index.ts"), "define({ activate() {} });");
    await writeFile(path.join(source, screenshot), png);
    await writeFile(path.join(source, icon), png);
    const outputRoot = path.join(directory, "output");
    const tool = fileURLToPath(
      new URL("../../../tools/build-desktop-extension.mjs", import.meta.url),
    );
    const build = () => promisify(execFile)(process.execPath, [tool, source, outputRoot]);
    await build();
    const output = path.join(outputRoot, "gallery");
    expect(await readFile(path.join(output, screenshot))).toEqual(png);
    expect(await readFile(path.join(output, icon))).toEqual(png);
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    expect(desktopExtensionManifestSchema.parse(manifest)).toMatchObject({
      icon,
      screenshots: [screenshot],
    });
    await writeFile(path.join(source, screenshot), "not a PNG");
    await expect(build()).rejects.toThrow(/Screenshot.*does not match image\/png/u);
    expect(await readFile(path.join(output, screenshot))).toEqual(png);
    await writeFile(path.join(source, screenshot), png);
    await writeFile(path.join(source, icon), "not a PNG");
    await expect(build()).rejects.toThrow(/Icon.*does not match image\/png/u);
    expect(await readFile(path.join(output, icon))).toEqual(png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
