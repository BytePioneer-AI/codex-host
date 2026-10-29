import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create } from "tar";
import { afterEach, expect, it } from "vitest";
import { inspectNpmArchive, npmPlatformPackage } from "../src/npm-archive.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function archive(options: { link?: boolean; duplicate?: boolean; script?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-archive-"));
  roots.push(root);
  await mkdir(path.join(root, "package/bin"), { recursive: true });
  const manifest = {
    name: "@codexhost/cli",
    version: "1.2.3",
    type: "module",
    bin: { codexhost: "bin/codexhost.js" },
    optionalDependencies: { [npmPlatformPackage(process.platform, process.arch)]: "1.2.3" },
    ...(options.script ? { scripts: { install: "node unexpected.js" } } : {}),
  };
  await writeFile(path.join(root, "package/package.json"), JSON.stringify(manifest));
  if (options.link) {
    await writeFile(path.join(root, "outside.js"), "fixture");
    await symlink(path.join(root, "outside.js"), path.join(root, "package/bin/codexhost.js"));
  } else await writeFile(path.join(root, "package/bin/codexhost.js"), "fixture");
  const file = path.join(root, "archive.tgz");
  await create({ file, gzip: true, cwd: root }, [
    "package/package.json",
    "package/bin/codexhost.js",
    ...(options.duplicate ? ["package/bin/codexhost.js"] : []),
  ]);
  return file;
}
function inspect(file: string, version = "1.2.3") {
  return inspectNpmArchive(
    file,
    "@codexhost/cli",
    version,
    process.platform,
    process.arch,
    AbortSignal.timeout(5_000),
  );
}
it("reads bounded package metadata without extracting or running it", async () => {
  await expect(inspect(await archive())).resolves.toBeGreaterThan(0);
});
it("rejects the wrong exact version", async () => {
  await expect(inspect(await archive(), "1.2.4")).rejects.toThrow("@codexhost/cli@1.2.4");
});
it.skipIf(process.platform === "win32")("rejects links instead of following them", async () => {
  await expect(inspect(await archive({ link: true }))).rejects.toThrow("unsafe");
});
it("rejects duplicate archive entries", async () => {
  await expect(inspect(await archive({ duplicate: true }))).rejects.toThrow(/duplicate|unsafe/iu);
});
it("rejects installation hooks that cannot be part of the closed offline set", async () => {
  await expect(inspect(await archive({ script: true }))).rejects.toThrow(
    "unsupported lifecycle scripts",
  );
});
