import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_LIST_SCREENSHOTS_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_LIMIT,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  desktopExtensionsListResultSchema,
} from "@codexhost/shared-contracts";
import {
  discoverDesktopExtensions,
  listDesktopExtensions,
  readDesktopExtensionConfiguration,
  writeDesktopExtensionConfiguration,
} from "../src/index.js";

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "desktop-extensions-"));
  root = path.join(directory, "desktop-extensions");
});
afterEach(() => rm(directory, { recursive: true, force: true }));

async function install(id: string, patch = {}) {
  const folder = path.join(root, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(folder, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      desktopApi: 1,
      id,
      name: "Test",
      version: "1",
      desktop: { script: "desktop.js" },
      slots: [],
      ...patch,
    }),
  );
  const file = path.join(folder, "desktop.js");
  await writeFile(file, "define({activate(){}})");
  return file;
}

it("discovers trusted files by content without evaluating code and rejects invalid and incompatible entries", async () => {
  const file = await install("valid");
  await install("mismatch", { id: "other" });
  await install("future", { desktopApi: 2 });
  const large = await install("large");
  await writeFile(large, Buffer.alloc(DESKTOP_EXTENSION_SCRIPT_MAX_BYTES + 1));
  const outside = path.join(directory, "outside.js");
  await writeFile(outside, "throw new Error('not an extension')");
  const link = await install("escape");
  await rm(link);
  await symlink(outside, link);
  const first = await discoverDesktopExtensions(root);
  expect(Object.fromEntries(first.extensions.map((item) => [item.id, item.state]))).toEqual({
    valid: "valid",
    mismatch: "invalid",
    future: "incompatible",
    large: "invalid",
    escape: "invalid",
  });
  await writeFile(file, "throw new Error('not evaluated')");
  const second = await discoverDesktopExtensions(root);
  expect(second.extensions.at(-1)).toMatchObject({
    state: "valid",
    script: "throw new Error('not evaluated')",
  });
  expect(second.extensions.at(-1)).not.toMatchObject({
    hash: (first.extensions.at(-1) as { hash: string }).hash,
  });
});

it("preserves bilingual metadata and diagnoses duplicate categories during discovery", async () => {
  const name = { en: "Sidebar badges", "zh-CN": "侧栏角标" };
  const description = { en: "Shows delegated Threads", "zh-CN": "显示委派的 Thread" };
  const categories = ["interface", "workflow"];
  await install("bilingual", { name, description, categories });
  await install("duplicate-tags", { name, categories: ["interface", "interface"] });
  expect((await discoverDesktopExtensions(root)).extensions).toEqual([
    expect.objectContaining({
      id: "bilingual",
      state: "valid",
      manifest: expect.objectContaining({ name, description, categories }),
    }),
    {
      id: "duplicate-tags",
      state: "invalid",
      error: expect.stringMatching(/Duplicate categories[\s\S]*categories/u),
    },
  ]);
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYQAAAAASUVORK5CYII=",
  "base64",
);

it("lists a verified local logo and screenshots in manifest order through the management schema", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
  const webp = Buffer.from("RIFF\0\0\0\0WEBP");
  const previews = [
    ["images/sidebar.PNG", png],
    ["images/status.jpeg", jpeg],
    ["images/preview.webp", webp],
  ] as const;
  const details = { en: "Overview\n\nUsage", "zh-CN": "概览\n\n用法" };
  const iconBytes = Buffer.alloc(DESKTOP_EXTENSION_ICON_MAX_BYTES);
  png.copy(iconBytes);
  const metadata = {
    author: "codexhost",
    icon: "images/logo.png",
    repository: "https://github.com/BytePioneer-AI/codex-host",
    details,
    screenshots: previews.map(([file]) => file),
  };
  const script = await install("gallery", metadata);
  await mkdir(path.join(path.dirname(script), "images"));
  await writeFile(path.join(path.dirname(script), metadata.icon), iconBytes);
  for (const [file, bytes] of previews) {
    await writeFile(path.join(path.dirname(script), file), bytes);
  }
  const list = desktopExtensionsListResultSchema.parse(await listDesktopExtensions(directory));
  expect(list.diagnostics).toEqual([]);
  expect(list.extensions).toMatchObject([
    {
      id: "gallery",
      manifest: metadata,
      status: { state: "disabled" },
      iconDataUrl: `data:image/png;base64,${iconBytes.toString("base64")}`,
      screenshotDataUrls: [
        `data:image/png;base64,${png.toString("base64")}`,
        `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        `data:image/webp;base64,${webp.toString("base64")}`,
      ],
    },
  ]);
});

it.each([
  ["missing", "preview.png", /file not found/u],
  ["oversize", "preview.png", /exceeds its limit/u],
  ["mislabeled", "preview.jpg", /signature does not match image\/jpeg/u],
  ["escape", "preview.png", /inside its root/u],
  ["traversal", "../preview.png", /relative paths/u],
  ["directory", "preview.png", /regular file/u],
] as const)("reports the screenshot path and reason for %s", async (kind, relative, reason) => {
  const file = await install("bad-shot", { screenshots: [relative] });
  const screenshot = path.join(path.dirname(file), relative);
  if (kind === "mislabeled") await writeFile(screenshot, png);
  if (kind === "oversize")
    await writeFile(screenshot, Buffer.alloc(DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES + 1));
  if (kind === "directory") await mkdir(screenshot);
  if (kind === "escape") {
    const external = path.join(directory, "outside.png");
    await writeFile(external, png);
    await symlink(external, screenshot);
  }
  const {
    extensions: [item],
  } = await discoverDesktopExtensions(root);
  expect(item).toMatchObject({ state: "invalid", error: expect.stringMatching(reason) });
  expect(item).toMatchObject({
    error: expect.stringContaining(kind === "traversal" ? "screenshots[0]" : relative),
  });
});

it.each(["missing", "oversize", "mislabeled", "escape"])(
  "omits a %s local logo without invalidating the extension",
  async (kind) => {
    const icon = "logo.png";
    const script = await install("with-logo", { icon });
    const logoPath = path.join(path.dirname(script), icon);
    if (kind === "oversize") {
      const bytes = Buffer.alloc(DESKTOP_EXTENSION_ICON_MAX_BYTES + 1);
      png.copy(bytes);
      await writeFile(logoPath, bytes);
    } else if (kind === "mislabeled") {
      await writeFile(logoPath, Buffer.from([0xff, 0xd8, 0xff]));
    } else if (kind === "escape") {
      const outside = path.join(directory, "outside.png");
      await writeFile(outside, png);
      await symlink(outside, logoPath);
    }
    const { extensions } = await listDesktopExtensions(directory);
    expect(extensions).toMatchObject([
      { id: "with-logo", manifest: { icon }, status: { state: "disabled" } },
    ]);
    expect(extensions[0]).not.toHaveProperty("iconDataUrl");
  },
);

it("rejects unsafe repository protocols during discovery", async () => {
  await install("unsafe-link", { repository: "javascript:alert(1)" });
  const { extensions } = await discoverDesktopExtensions(root);
  expect(extensions).toMatchObject([
    { state: "invalid", error: expect.stringContaining("repository") },
  ]);
});

it("bounds list previews without marking otherwise valid installations invalid", async () => {
  const screenshots = Array.from(
    { length: DESKTOP_EXTENSION_SCREENSHOT_LIMIT },
    (_, i) => `${i}.png`,
  );
  const bytes = Buffer.alloc(DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES);
  png.copy(bytes);
  const galleriesThatFit = Math.floor(
    DESKTOP_EXTENSION_LIST_SCREENSHOTS_MAX_BYTES / (bytes.length * screenshots.length),
  );
  for (let i = 0; i <= galleriesThatFit; i++) {
    const dir = path.dirname(await install(`gallery-${i}`, { screenshots }));
    await Promise.all(screenshots.map((file) => writeFile(path.join(dir, file), bytes)));
  }
  const list = await listDesktopExtensions(directory);
  expect(list.diagnostics).toEqual([expect.stringContaining("some previews were omitted")]);
  expect(list.extensions.map((item) => item.status.state)).toEqual(
    Array(galleriesThatFit + 1).fill("disabled"),
  );
  expect(list.extensions.map((item) => item.screenshotDataUrls?.length)).toEqual([
    ...Array(galleriesThatFit).fill(screenshots.length),
    undefined,
  ]);
});

it("packages nested logos and screenshots and rejects invalid image bytes before publishing", async () => {
  const icon = "images/logo.png";
  const screenshot = "images/sidebar.png";
  const source = path.dirname(await install("gallery", { icon, screenshots: [screenshot] }));
  await mkdir(path.join(source, "src"));
  await mkdir(path.join(source, "images"));
  await writeFile(path.join(source, "src", "index.ts"), "define({ activate() {} });");
  await writeFile(path.join(source, screenshot), png);
  await writeFile(path.join(source, icon), png);
  const outputRoot = path.join(directory, "output");
  const buildTool = fileURLToPath(
    new URL("../../../tools/build-desktop-extension.mjs", import.meta.url),
  );
  const build = () => promisify(execFile)(process.execPath, [buildTool, source, outputRoot]);
  await build();
  const output = path.join(outputRoot, "gallery", screenshot);
  const outputIcon = path.join(outputRoot, "gallery", icon);
  expect(await readFile(output)).toEqual(png);
  expect(await readFile(outputIcon)).toEqual(png);
  expect((await discoverDesktopExtensions(outputRoot)).extensions).toMatchObject([
    { state: "valid", manifest: { icon, screenshots: [screenshot] } },
  ]);
  await writeFile(path.join(source, screenshot), "not a PNG");
  await expect(build()).rejects.toThrow(/Screenshot.*does not match image\/png/u);
  expect(await readFile(output)).toEqual(png);
  await writeFile(path.join(source, screenshot), png);
  await writeFile(path.join(source, icon), "not a PNG");
  await expect(build()).rejects.toThrow(/Icon.*does not match image\/png/u);
  expect(await readFile(outputIcon)).toEqual(png);
});

it.skipIf(!process.getuid)("rejects another user's writable root and files on POSIX", async () => {
  const file = await install("example");
  await chmod(file, 0o622);
  expect((await discoverDesktopExtensions(root)).extensions[0]).toMatchObject({
    state: "invalid",
    error: expect.stringMatching(/group\/other writes/u),
  });
  await chmod(root, 0o777);
  expect(await discoverDesktopExtensions(root)).toMatchObject({
    extensions: [],
    diagnostic: expect.stringMatching(/group\/other writes/u),
  });
});

it("prevents two management processes from overwriting the same revision", async () => {
  const source = `
    import { once } from 'node:events';
    import { setTimeout } from 'node:timers/promises';
    import { DesktopExtensionRevisionConflict, writeDesktopExtensionConfiguration } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const start = once(process, 'message');
    process.send('ready');
    await start;
    try {
      await writeDesktopExtensionConfiguration(process.argv[1], 0, async () => {
        await setTimeout(250);
        return { enabled: [process.argv[2]] };
      });
      process.send('saved');
    } catch (error) {
      if (!(error instanceof DesktopExtensionRevisionConflict)) throw error;
      process.send('stale');
    } finally {
      process.disconnect();
    }
  `;
  const workers = ["first", "second"].map((id) =>
    spawn(process.execPath, ["--input-type=module", "--eval", source, root, id], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }),
  );
  const receive = (worker: (typeof workers)[number]) =>
    Promise.race([
      once(worker, "message").then(([message]) => message as unknown),
      once(worker, "exit").then(([code]) => {
        throw new Error(`Configuration worker exited: ${code}`);
      }),
    ]);
  try {
    await Promise.all(workers.map(receive));
    const confirmed = Promise.all(workers.map(receive));
    for (const worker of workers) worker.send("start");
    const outcomes = await confirmed;
    expect(outcomes).toEqual(expect.arrayContaining(["saved", "stale"]));
    expect((await readDesktopExtensionConfiguration(root)).configuration).toMatchObject({
      revision: 1,
      enabled: [outcomes[0] === "saved" ? "first" : "second"],
    });
  } finally {
    for (const worker of workers) if (worker.exitCode === null) worker.kill();
  }
});

it("treats missing configuration as a normal empty selection", async () => {
  const empty = { configuration: { version: 1, enabled: [], revision: 0 } };
  expect(await readDesktopExtensionConfiguration(root)).toStrictEqual(empty);
  await mkdir(root, { mode: 0o700 });
  expect(await readDesktopExtensionConfiguration(root)).toStrictEqual(empty);
});

it("saves recovery tokens and fails closed on damaged configuration", async () => {
  await writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["example"] }));
  const reloadToken = "bbd3fcb4-27e1-44ad-9ed2-a384ae8b3619";
  await writeDesktopExtensionConfiguration(root, 1, () => ({ enabled: [], reloadToken }));
  expect(await readDesktopExtensionConfiguration(root)).toEqual({
    configuration: { version: 1, enabled: [], revision: 2, reloadToken },
  });
  await writeFile(path.join(root, "enabled.json"), "{!");
  expect(await readDesktopExtensionConfiguration(root)).toMatchObject({
    configuration: { enabled: [] },
    diagnostic: expect.stringMatching(/invalid/iu),
  });
});
