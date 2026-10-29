import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { linkFixtureDependencies, assertFixtureInputs } from "./fixture-workspace.mjs";

test("real esbuild follows a shared workspace junction back to other dist; local workspace links prevent it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fixture-runtime-source-"));
  try {
    const repository = path.join(root, "repository"),
      source = path.join(root, "private-source");
    const names = ["packages/lib/package.json"];
    for (const [directory, marker] of [
      [repository, "WRONG_OTHER_WORKSPACE_DIST"],
      [source, "PRIVATE_VERSION_RUNTIME"],
    ]) {
      await mkdir(path.join(directory, "packages/lib/dist"), { recursive: true });
      await writeFile(
        path.join(directory, names[0]),
        JSON.stringify({
          name: "@codexhost/fixture-lib",
          type: "module",
          exports: "./dist/index.js",
        }),
      );
      await writeFile(
        path.join(directory, "packages/lib/dist/index.js"),
        `export const marker = ${JSON.stringify(marker)};`,
      );
    }
    await mkdir(path.join(repository, "node_modules/@codexhost"), { recursive: true });
    await symlink(
      path.join(repository, "packages/lib"),
      path.join(repository, "node_modules/@codexhost/fixture-lib"),
      "junction",
    );
    await writeFile(
      path.join(source, "entry.mjs"),
      "import {marker} from '@codexhost/fixture-lib'; console.log(marker);",
    );
    await symlink(
      path.join(repository, "node_modules"),
      path.join(source, "node_modules"),
      "junction",
    );
    const bundle = () =>
      build({
        absWorkingDir: source,
        entryPoints: ["entry.mjs"],
        bundle: true,
        platform: "node",
        write: false,
        metafile: true,
        logLevel: "silent",
      });
    const wrong = await bundle();
    expect(wrong.outputFiles[0].text).toContain("WRONG_OTHER_WORKSPACE_DIST");
    await expect(
      assertFixtureInputs(source, source, Object.keys(wrong.metafile.inputs)),
    ).rejects.toThrow("escaped fixture");
    await rm(path.join(source, "node_modules"));
    const links = await linkFixtureDependencies(repository, source, names);
    expect(links[0].realpath).toBe(await realpath(path.join(source, "packages/lib")));
    const correct = await bundle();
    expect(correct.outputFiles[0].text).toContain("PRIVATE_VERSION_RUNTIME");
    expect(correct.outputFiles[0].text).not.toContain("WRONG_OTHER_WORKSPACE_DIST");
    const inputs = await assertFixtureInputs(source, source, Object.keys(correct.metafile.inputs));
    expect(inputs.map((i) => i.path.replaceAll("\\", "/"))).toContain("packages/lib/dist/index.js");
    expect(await readFile(path.join(repository, "packages/lib/dist/index.js"), "utf8")).toContain(
      "WRONG_OTHER_WORKSPACE_DIST",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
