import { expect, it } from "vitest";
import { WEB_FOLLOW_PROJECTION_KEYS } from "@codexhost/shared-contracts";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import { TYPERT_REMOTE } from "@deepseek-ai/dsh-api-session-controller/remote";
import { ProjectionValueStore } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/projection-store.ts";
import { SessionManager } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/manager.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";

it("the generated follow codec accepts projection frames and validates their watermark", () => {
  const descriptor = TYPERT_REMOTE.descriptors.find(
    (entry) => entry.namespace === "session" && entry.method === "follow",
  );
  if (descriptor?.result.mode !== "strict") throw new Error("Missing strict follow result codec");
  const schema = descriptor.result.create();
  for (const key of WEB_FOLLOW_PROJECTION_KEYS) {
    const frame = {
      type: "projection",
      sessionId: "b",
      key,
      value: { nested: [{ output: "latest" }] },
      seq: 10,
    };
    expect(schema.parse(frame)).toEqual(frame);
    expect(() => schema.parse({ ...frame, seq: "invalid" })).toThrow();
  }
});

it("applies ordered follow replacements at equal seq without accepting older watermarks", () => {
  const store = new ProjectionValueStore();
  const seq = SessionSeq(10);
  store.seed(
    { asOfSeq: seq, values: { codexhostTurnChanges: { 1: ["a"] } } },
    WEB_FOLLOW_PROJECTION_KEYS,
  );
  store.applyLive("codexhostTurnChanges", { 1: ["a", "b"] }, seq);
  expect(store.get("codexhostTurnChanges")).toEqual({ 1: ["a", "b"] });
  // Switching back opens a fresh snapshot even if no journal event was appended.
  store.seed(
    { asOfSeq: seq, values: { codexhostTurnChanges: { 1: ["a", "b", "c"] } } },
    WEB_FOLLOW_PROJECTION_KEYS,
  );
  store.applyLive("codexhostTurnChanges", { 1: ["stale"] }, SessionSeq(9));
  expect(store.get("codexhostTurnChanges")).toEqual({ 1: ["a", "b", "c"] });
  // Non-live baselines retain their higher-seq-wins rule.
  store.seed({ asOfSeq: seq, values: { codexhostTurnChanges: { 1: ["stale"] } } });
  expect(store.get("codexhostTurnChanges")).toEqual({ 1: ["a", "b", "c"] });
});

it("a follow snapshot cannot overwrite a global control update at the same seq", () => {
  const store = new ProjectionValueStore();
  const seq = SessionSeq(10);
  store.applyLive("title", "new title", seq);
  store.seed(
    {
      asOfSeq: seq,
      values: { title: "older follow snapshot", codexhostToolOutput: { command: "latest" } },
    },
    WEB_FOLLOW_PROJECTION_KEYS,
  );
  expect(store.get("title")).toBe("new title");
  expect(store.get("codexhostToolOutput")).toEqual({ command: "latest" });
});

it("a rebuilt control baseline clears missing global and cached rows but preserves follow-owned keys", async () => {
  const manager = new SessionManager({} as SessionRemotes);
  const sessionId = SessionId("b");
  const store = manager.get(sessionId).projections;
  store.seed(
    {
      asOfSeq: SessionSeq(10),
      values: {
        title: "Before",
        goal: "removed global value",
        codexhostToolOutput: { command: "live" },
        codexhostTurnChanges: { 1: ["a"] },
      },
    },
    WEB_FOLLOW_PROJECTION_KEYS,
  );
  store.applyCached({ cachedGlobal: "stale", codexhostToolOutput: { command: "stale" } });
  store.applyLive("newerGlobal", "newer than baseline", SessionSeq(12));
  manager.handleControlFrame({
    type: "baseline",
    value: { projections: { [sessionId]: { asOfSeq: 11, values: { title: "After" } } } },
  });
  expect(store.get("goal")).toBeUndefined();
  expect(store.get("cachedGlobal")).toBeUndefined();
  expect(store.get("codexhostToolOutput")).toEqual({ command: "live" });
  expect(store.get("codexhostTurnChanges")).toEqual({ 1: ["a"] });
  expect(store.get("newerGlobal")).toBe("newer than baseline");
  expect(store.get("title")).toBe("After");
  await manager.dispose();
});

it("a partial control baseline preserves follow-owned values while updating global keys", async () => {
  const manager = new SessionManager({} as SessionRemotes);
  const sessionId = SessionId("b");
  manager.get(sessionId).projections.seed(
    {
      asOfSeq: SessionSeq(10),
      values: { codexhostToolOutput: { command: "live" }, title: "Before" },
    },
    WEB_FOLLOW_PROJECTION_KEYS,
  );
  manager.handleControlFrame({
    type: "baseline",
    value: { projections: { [sessionId]: { asOfSeq: 11, values: { title: "After" } } } },
  });
  const values = manager.projectionValues(sessionId) as Record<string, unknown>;
  expect(values.codexhostToolOutput).toEqual({ command: "live" });
  expect(values.title).toBe("After");
  await manager.dispose();
});
