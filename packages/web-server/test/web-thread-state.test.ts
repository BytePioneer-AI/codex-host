import assert from "node:assert/strict";
import { it } from "node:test";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { WebThreadStates } from "../src/web-thread-state.ts";
import { FakeChHost } from "./support/ch-host.ts";

function tracked(states: WebThreadStates, id: string) {
  const host = new FakeChHost();
  const view = new ChThreadHistory(host, host.add(id, "/project"), "fake", () => {});
  const state = states.ensure(id);
  state.view = view;
  state.reading = Promise.resolve(view);
  state.controls = Promise.resolve();
  state.usageReadAt = 1;
  state.historyReadAt = 2;
  state.harnessId = "fake";
  return view;
}

it("clears every derived field for all Threads on a new Host generation, keeping owners and origins", () => {
  const states = new WebThreadStates();
  const a = tracked(states, "a");
  const b = tracked(states, "b");
  assert.deepEqual(states.newHostGeneration(), [a, b]);
  for (const [id, view] of [
    ["a", a],
    ["b", b],
  ] as const) {
    const state = states.get(id);
    assert.deepEqual(Object.keys(state ?? {}).sort(), ["harnessId", "viewOrigin"]);
    assert.equal(state?.viewOrigin, view.log.lastSeq + 2);
  }
  assert.deepEqual(states.views(), []);
});

it("discards one view without touching its in-flight read or other Threads", () => {
  const states = new WebThreadStates();
  const a = tracked(states, "a");
  const b = tracked(states, "b");
  states.discardView("a", a);
  assert.equal(states.view("a"), undefined);
  assert.ok(states.get("a")?.reading, "an in-flight read settles on its own");
  assert.equal(states.get("a")?.usageReadAt, undefined);
  assert.equal(states.get("a")?.controls, undefined);
  assert.equal(states.get("a")?.viewOrigin, a.log.lastSeq + 2);
  assert.equal(states.view("b"), b);
});

it("replaces confirmed owners as a whole and forgets Threads nothing else tracks", () => {
  const states = new WebThreadStates();
  tracked(states, "kept-with-view");
  states.setHarness("only-owner", "fake");
  states.replaceHarnesses(new Map([["new", "other"]]));
  assert.equal(states.harnessId("only-owner"), undefined);
  assert.equal(states.get("only-owner"), undefined);
  assert.equal(states.harnessId("kept-with-view"), undefined);
  assert.ok(states.view("kept-with-view"), "a followed view survives a catalog refresh");
  assert.equal(states.harnessId("new"), "other");
  states.ensure("unknown");
  states.prune("unknown");
  assert.equal(states.get("unknown"), undefined);
});

it("forgets known Turns on every live view", () => {
  const states = new WebThreadStates();
  const a = tracked(states, "a");
  a.thread.turns = [{ id: "t", status: "completed", items: [], fingerprint: "f" }];
  states.forgetKnownTurns();
  assert.equal(a.thread.turns[0]?.fingerprint, undefined);
});
