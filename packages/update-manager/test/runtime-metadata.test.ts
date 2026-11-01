import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { readRuntimeMetadata } from "../src/runtime-metadata.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-runtime-version-"));
  roots.push(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "codexhost", version: "0.12.0" }),
  );
  return root;
}

it("gives all source entrypoints the same launch version without changing workspace files", async () => {
  const root = await workspace();
  for (const name of ["host-runtime", "console-server"]) {
    const entry = path.join(root, "packages", name, "dist/main.js");
    await expect(readRuntimeMetadata(entry, {})).resolves.toEqual({
      version: "0.12.0-dev",
      distribution: "development",
    });
    for (const version of ["0.11.0", "0.13.0-rc.1+test"]) {
      await expect(readRuntimeMetadata(entry, { CODEXHOST_DEV_VERSION: version })).resolves.toEqual(
        { version, distribution: "development" },
      );
    }
    await expect(readRuntimeMetadata(entry, { CODEXHOST_DEV_VERSION: "latest" })).rejects.toThrow(
      "semantic version",
    );
    await expect(readRuntimeMetadata(entry, {})).resolves.toHaveProperty("version", "0.12.0-dev");
  }
});

it("uses release metadata instead of an inherited source override", async () => {
  const root = await workspace();
  const app = path.join(root, "app");
  await mkdir(app);
  await writeFile(
    path.join(app, "codexhost-distribution.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.12.0",
      distribution: "npm",
      target: "linux-x64",
    }),
  );
  await expect(
    readRuntimeMetadata(path.join(app, "main.js"), { CODEXHOST_DEV_VERSION: "0.99.0" }),
  ).resolves.toMatchObject({ version: "0.12.0", distribution: "npm" });
});

it("does not accept arbitrary directories or other repositories as source builds", async () => {
  const root = await workspace();
  const environment = { CODEXHOST_DEV_VERSION: "0.99.0" };
  await expect(readRuntimeMetadata(path.join(root, "app/main.js"), environment)).rejects.toThrow();
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "other", version: "0.12.0" }),
  );
  await expect(
    readRuntimeMetadata(path.join(root, "packages/host-runtime/dist/main.js"), environment),
  ).rejects.toThrow();
});
