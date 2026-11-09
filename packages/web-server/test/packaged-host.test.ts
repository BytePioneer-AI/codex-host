import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { snapshotPackagedHost } from "../src/packaged-host.ts";

it("publishes complete, deduplicated Host payloads that survive replacement of Web output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexhost-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, "web"),
    data = join(root, "data");
  for (const directory of ["app", "native", "adapters/fixture/assets"])
    await mkdir(join(distribution, directory), { recursive: true });
  const files = {
    "app/host-runtime.mjs": "export const version = 1;",
    "native/codexhost": "launcher",
    "adapters/enabled.json": '{"version":1,"enabled":["fixture"]}',
    "adapters/fixture/plugin.mjs": "export const version = 1;",
    "adapters/fixture/assets/worker.mjs": "worker version 1",
  };
  for (const [file, content] of Object.entries(files))
    await writeFile(join(distribution, file), content);
  await chmod(join(distribution, "native/codexhost"), 0o755);
  const [first, duplicate] = await Promise.all([
    snapshotPackagedHost(distribution, data),
    snapshotPackagedHost(distribution, data),
  ]);
  assert.equal(first, duplicate);
  if (process.platform !== "win32")
    assert.equal((await stat(join(first, "native/codexhost"))).mode & 0o777, 0o755);
  await writeFile(join(distribution, "adapters/fixture/assets/worker.mjs"), "worker version 2");
  const second = await snapshotPackagedHost(distribution, data);
  assert.notEqual(first, second, "runtime assets participate in build identity");
  await rm(distribution, { recursive: true });
  for (const [file, content] of Object.entries(files))
    assert.equal(await readFile(join(first, file), "utf8"), content);
  assert.equal(
    await readFile(join(second, "adapters/fixture/assets/worker.mjs"), "utf8"),
    "worker version 2",
  );
  assert.equal((await readdir(join(data, "host-builds"))).length, 2);
});

it("does not publish a partial payload when a required runtime file is missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexhost-snapshot-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(snapshotPackagedHost(join(root, "missing"), root));
  assert.deepEqual(await readdir(join(root, "host-builds")), []);
});
