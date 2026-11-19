import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DESKTOP_EXTENSION_SCRIPT_MAX_BYTES } from "@codexhost/shared-contracts";
import {
  DesktopExtensionRevisionConflict,
  discoverDesktopExtensions,
  readDesktopExtensionConfiguration,
  writeDesktopExtensionConfiguration,
} from "../src/index.js";

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "desktop-extensions-"));
  root = path.join(directory, "extensions");
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

it("serializes revisions, saves recovery tokens and fails closed on damaged configuration", async () => {
  expect(await readDesktopExtensionConfiguration(root)).toMatchObject({
    configuration: { enabled: [], revision: 0 },
    diagnostic: expect.any(String),
  });
  const results = await Promise.allSettled([
    writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["example"] })),
    writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: [] })),
  ]);
  expect(results[0]).toMatchObject({
    status: "fulfilled",
    value: { revision: 1, enabled: ["example"] },
  });
  expect(results[1]).toMatchObject({
    status: "rejected",
    reason: expect.any(DesktopExtensionRevisionConflict),
  });
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
