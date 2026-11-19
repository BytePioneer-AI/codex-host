import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
  harnessSessionImportResultSchema,
  harnessSessionImportSourcesResultSchema,
  harnessSessionListResultSchema,
} from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { SessionImportHost } from "./support/session-import.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "web-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new SessionImportHost();
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  sessions.registerImport(rpc);
  const call = async (method: string, request: object = {}) => {
    const result = await rpc.dispatch(method, { args: { request } });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value;
  };
  return { host, rpc, call };
}

it("preserves public import contracts, filtering, pagination and explicit Harness identity", async (t) => {
  const { host, call } = fixture(t);
  assert.deepEqual(
    harnessSessionImportSourcesResultSchema.parse(await call("codexhost/importSources")),
    {
      harnesses: host.sources,
    },
  );
  const listed = harnessSessionListResultSchema.parse(
    await call("codexhost/importCandidates", {
      harnessId: "fake",
      offset: 20,
      limit: 20,
    }),
  );
  assert.equal(listed.total, 25);
  assert.equal(listed.candidates.length, 5);
  assert.equal(listed.candidates[0]?.nativeSessionId, "native-20");
  const searched = harnessSessionListResultSchema.parse(
    await call("codexhost/importCandidates", {
      harnessId: "fake",
      query: "native-24",
      offset: 0,
      limit: 20,
    }),
  );
  assert.equal(searched.total, 1);
  const imported = harnessSessionImportResultSchema.parse(
    await call("codexhost/import", {
      harnessId: "pi",
      nativeSessionId: "native-2",
    }),
  );
  assert.equal(imported.threadId, "import-pi-native-2");
  assert.deepEqual(
    await call("codexhost/import", { harnessId: "pi", nativeSessionId: "native-2" }),
    imported,
  );
  const fake = harnessSessionListResultSchema.parse(
    await call("codexhost/importCandidates", { harnessId: "fake" }),
  );
  assert.ok(fake.candidates.some((row) => row.nativeSessionId === "native-2"));
  assert.deepEqual(await call("codexhost/importCandidates", { harnessId: "pi" }), {
    candidates: [],
    total: 0,
  });
  const catalog = (await call("session/list")) as { items: Array<{ sessionId: string }> };
  assert.ok(catalog.items.some((row) => row.sessionId === imported.threadId));
  const history = await call("session/page", {
    address: { sessionId: imported.threadId },
    throughSeq: Number.MAX_SAFE_INTEGER,
  });
  assert.match(JSON.stringify(history), /existing CH answer/);
  assert.equal(
    host.requests.some((r) => ["thread/start", "turn/start"].includes(r.method)),
    false,
  );
});

it("returns a confirmed Thread even when refreshing the catalog fails, and never hides import errors", async (t) => {
  const { host, rpc, call } = fixture(t);
  await call("session/list");
  host.failCatalogAfterImport = true;
  assert.deepEqual(
    await call("codexhost/import", { harnessId: "fake", nativeSessionId: "native-2" }),
    {
      threadId: "import-fake-native-2",
    },
  );
  host.failCatalogAfterImport = false;
  await call("session/list");
  host.importError = "Native Session disappeared";
  const failed = await rpc.dispatch("codexhost/import", {
    args: {
      request: {
        harnessId: "fake",
        nativeSessionId: "native-3",
      },
    },
  });
  assert.ok(!failed.ok);
  assert.match(failed.error.message, /Native Session disappeared/);
  assert.equal(host.mappings.size, 1);
});
