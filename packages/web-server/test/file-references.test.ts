import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { WebFileReferences } from "../src/file-references.ts";
import { RpcRegistry } from "../src/transport.ts";

it("isolates workspace indexes, refreshes edits, and releases discovery at shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "web-file-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = join(root, "one");
  const two = join(root, "two");
  await mkdir(join(one, "nested"), { recursive: true });
  await mkdir(two);
  await writeFile(join(one, "nested", "first.ts"), "one");
  await writeFile(join(two, "second.ts"), "two");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const service = new WebFileReferences((id) =>
    id === "one" ? one : id === "two" ? two : undefined,
  );
  t.after(() => service.close());
  const rpc = new RpcRegistry();
  service.register(rpc);
  const search = async (id: string, query: string) => {
    const result = await rpc.dispatch("fileReferences/list", { args: { agentId: id, query } });
    assert.equal(result.ok, true);
    return result.ok ? result.value : undefined;
  };
  assert.deepEqual(await search("one", "first"), [{ path: "nested/first.ts", kind: "file" }]);
  assert.deepEqual(await search("two", "first"), []);
  await writeFile(join(one, "nested", "fresh.ts"), "fresh");
  now += 2_001;
  // The first stale request answers immediately while its replacement scans.
  assert.deepEqual(await search("one", "fresh"), []);
  let result: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(5);
    result = await search("one", "fresh");
    if (Array.isArray(result) && result.length) break;
  }
  assert.deepEqual(result, [{ path: "nested/fresh.ts", kind: "file" }]);
  assert.deepEqual(await search("one", "../two/"), []);
  const unknown = await rpc.dispatch("fileReferences/list", {
    args: { agentId: "unknown", query: "" },
  });
  assert.equal(unknown.ok, false);
  service.close();
});
