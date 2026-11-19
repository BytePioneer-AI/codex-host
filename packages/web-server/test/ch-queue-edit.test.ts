import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

for (const outcome of ["deleted", "missing", "failed", "refresh-failed"] as const)
  it(`acknowledges queue removal only from its mutation result: ${outcome}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-queue-edit-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    host.add("queue-thread", directory);
    const request = host.request.bind(host);
    const snapshot = host.snapshot.bind(host);
    let removed = false;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method !== "thread/queue/delete") return request<T>(method, params);
      assert.equal(params.queuedSubmissionId, "queued-id");
      if (outcome === "failed") throw new Error("Disconnected; outcome unknown");
      removed = outcome !== "missing";
      return { deleted: removed } as T;
    };
    host.snapshot = async (id) => {
      if (removed && outcome === "refresh-failed") throw new Error("Snapshot unavailable");
      return snapshot(id);
    };
    const sessions = new ChSessions(
      host,
      new Workspaces(new DataDir(directory), directory),
      new EventHub(directory),
    );
    t.after(() => sessions.close());
    const rpc = new RpcRegistry();
    sessions.register(rpc, new StreamRegistry());
    const result = await rpc.dispatch("session/updateQueue", {
      args: {
        request: { sessionId: "queue-thread", itemId: "queued-id", action: { kind: "remove" } },
      },
    });
    assert.equal(result.ok, removed);
    if (outcome === "missing") {
      assert.ok(!result.ok);
      assert.equal(result.error.code, "session/queue-item-not-found");
    }
  });
