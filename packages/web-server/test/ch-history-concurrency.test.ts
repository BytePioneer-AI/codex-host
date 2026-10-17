import assert from "node:assert/strict";
import { it } from "node:test";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { FakeChHost } from "./support/ch-host.ts";

it("a slow background older page does not block new tail output", async (t) => {
  const host = new FakeChHost();
  const row = host.add("history", "/project");
  const initial = row.turns[0];
  assert.ok(initial);
  row.turns = Array.from({ length: 12 }, (_, i) => ({ ...initial, id: `turn-${i}` }));
  const view = new ChThreadHistory(host, row, "fake", () => {});
  await view.refresh();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/turns/list" && params.cursor) await gate;
    return request<T>(method, params);
  };
  const older = view.prefetchOlder();
  row.turns.push({ ...initial, id: "new-turn" });
  row.updatedAt++;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      view.refresh(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Tail blocked by background history")), 500);
      }),
    ]);
    assert.equal(view.thread.turns.at(-1)?.id, "new-turn");
  } finally {
    clearTimeout(timeout);
    release();
    await older;
  }
  assert.equal(view.thread.turns[0]?.id, "turn-2");
  const count = host.requests.length;
  await view.prefetchOlder();
  assert.equal(host.requests.length, count, "reopening does not drain another older page");
});
