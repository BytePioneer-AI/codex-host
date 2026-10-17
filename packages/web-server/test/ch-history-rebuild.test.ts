import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

it("keeps queue projection watermarks increasing after native history is rebuilt", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ch-history-rebuild-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("rebuild-thread", directory);
  row.status = { type: "active" };
  const original = row.turns[0];
  assert.ok(original);
  row.turns = Array.from({ length: 5 }, (_, index) => ({ ...original, id: `old-${index}` }));
  let queue: ClientThreadSnapshot["queue"] = { items: [], pausedReason: null };
  const snapshot = host.snapshot.bind(host);
  host.snapshot = async (id) => ({ ...(await snapshot(id)), queue: structuredClone(queue) });
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(directory), directory),
    new EventHub(directory),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const read = () =>
    rpc.dispatch("session/projections", {
      args: { request: { sessionId: row.id } },
    });
  const baseline = async () => {
    const result = await read();
    assert.ok(result.ok);
    return result.value as {
      asOfSeq: number;
      values: { inbox: { "next-turn": Array<{ id: string }> } };
    };
  };
  let previous = await baseline();
  // A rewritten native transcript retires the disposable Web journal. The
  // browser keeps its projection store when it reopens the same Thread.
  for (let generation = 0; generation < 2; generation++) {
    row.turns = [{ ...original, id: `replacement-${generation}` }];
    row.updatedAt++;
    const rejected = await read();
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "host/history-changed");
    queue = {
      pausedReason: null,
      items: [
        {
          id: `queued-${generation}`,
          clientUserMessageId: `input-${generation}`,
          input: [{ type: "text", text: "still pending" }],
          presentationInput: null,
        },
      ],
    };
    const rebuilt = await baseline();
    assert.ok(
      rebuilt.asOfSeq > previous.asOfSeq,
      "rebuilt projections must supersede the browser's old watermark",
    );
    assert.deepEqual(
      rebuilt.values.inbox["next-turn"].map((item) => item.id),
      [`queued-${generation}`],
    );
    queue = { items: [], pausedReason: null };
    const consumed = await baseline();
    assert.ok(consumed.asOfSeq >= rebuilt.asOfSeq);
    assert.deepEqual(consumed.values.inbox["next-turn"], []);
    previous = consumed;
  }
});
