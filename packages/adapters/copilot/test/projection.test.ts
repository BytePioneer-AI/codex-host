import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HostEvent } from "@codexhost/harness-adapter";
import { CopilotItems, projectHistory } from "../src/projection.js";
import { forkBoundary, rootMessages } from "../src/history.js";
import { sessionRef, sessionIdFromRef } from "../src/refs.js";

const fixture = (name: string): SessionEvent[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const sessionId = "4c47b75e-1f33-4e80-a592-032e42c24f4b";

describe("Copilot native event projection (CLI 1.0.102)", () => {
  it("keeps start order through out-of-order completion, duplicates, and cancellation", () => {
    const start = fixture("file-change").find((event) => event.type === "tool.execution_start");
    const complete = fixture("file-change").find(
      (event) => event.type === "tool.execution_complete",
    );
    if (!start || !complete) throw new Error("Missing fixture");
    const reducer = new CopilotItems(hostTurnIdSchema.parse("ordered"), () => {});
    for (const id of ["first", "second", "cancelled"])
      reducer.accept({ ...start, data: { ...start.data, toolCallId: id } });
    for (const id of ["second", "first", "second"])
      reducer.accept({
        ...complete,
        data: { toolCallId: id, success: true, result: { content: id } },
      });
    reducer.finishAll({ status: "cancelled" });
    reducer.accept({ ...complete, data: { ...complete.data, toolCallId: "cancelled" } });
    expect(reducer.items.map(({ item }) => item.itemId)).toEqual(["first", "second", "cancelled"]);
    expect(reducer.items.map(({ outcome }) => outcome.status)).toEqual([
      "succeeded",
      "succeeded",
      "cancelled",
    ]);
    expect([...reducer.completedIds()]).toEqual(["second", "first", "cancelled"]);
    expect(reducer.active.size).toBe(0);
  });
  it("rejects orphan tool completion instead of creating an unowned file change", () => {
    const completion = fixture("file-change").find(
      (event) => event.type === "tool.execution_complete",
    );
    if (!completion) throw new Error("Missing completion fixture");
    const emitted: HostEvent[] = [];
    const reducer = new CopilotItems(hostTurnIdSchema.parse("orphan"), (event) =>
      emitted.push(event),
    );
    reducer.accept(completion);
    expect(reducer.items).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it.each([false, true])(
    "keeps cross-root tool completion with its original history owner (cancelled: %s)",
    (cancelled) => {
      const users = rootMessages(fixture("basic"));
      const first = users[0],
        second = users[1];
      const start = fixture("file-change").find((event) => event.type === "tool.execution_start");
      const completion = fixture("file-change").find(
        (event) => event.type === "tool.execution_complete",
      );
      const abort = fixture("lifecycle").find((event) => event.type === "abort");
      if (!first || !second || !start || !completion || !abort)
        throw new Error("Missing native fixtures");
      const events = [
        first,
        start,
        ...(cancelled ? [abort] : []),
        second,
        completion,
        start,
        completion,
      ];
      const history = projectHistory(sessionId, events);
      expect(history.turns[1]?.items).toEqual([]);
      const items = history.turns[0]?.items ?? [];
      expect(items.filter(({ item }) => item.type === "fileChange")).toHaveLength(1);
      expect(items.find(({ item }) => item.itemId === start.data.toolCallId)?.outcome.status).toBe(
        "succeeded",
      );
      expect(history.turns[0]?.outcome.status).toBe(cancelled ? "cancelled" : "unknown");
      for (const { item } of items)
        if (item.type === "fileChange")
          expect(
            item.sourceItemIds?.every((id) => items.some(({ item }) => item.itemId === id)),
          ).toBe(true);
    },
  );
  it("projects only acknowledged native file diffs and links them to the tool", () => {
    const events = fixture("file-change");
    const reducer = new CopilotItems(hostTurnIdSchema.parse("files"), () => {});
    for (const event of events) reducer.accept(event);
    const file = reducer.items.find(({ item }) => item.type === "fileChange")?.item;
    expect(file?.type).toBe("fileChange");
    if (file?.type !== "fileChange") throw new Error("Missing native file change");
    expect(file.changes[0]).toMatchObject({ path: "/workspace/probe.txt", kind: "add" });
    expect(file.sourceItemIds).toHaveLength(1);
  });

  it("fails oversized text instead of presenting a truncated successful answer", () => {
    const reducer = new CopilotItems(hostTurnIdSchema.parse("limit"), () => {});
    const sample = fixture("basic").find((event) => event.type === "assistant.message");
    if (!sample || sample.type !== "assistant.message") throw new Error("Missing native answer");
    expect(() =>
      reducer.accept({ ...sample, data: { ...sample.data, content: "x".repeat(256 * 1024 + 1) } }),
    ).toThrow(/output limit/);
    expect(reducer.items).toHaveLength(0);
  });
  it("deduplicates streamed/full answers and matches stable historical identities", () => {
    const events = fixture("basic");
    const users = rootMessages(events);
    const firstUser = users[0];
    const secondUser = users[1];
    expect(firstUser?.data.messageId).toBeTruthy();
    expect(secondUser?.data.messageId).toBeTruthy();
    const emitted: HostEvent[] = [];
    const reducer = new CopilotItems(hostTurnIdSchema.parse("host-turn"), (event) =>
      emitted.push(event),
    );
    const secondIndex = events.findIndex((event) => event.id === secondUser?.id);
    for (const event of events.slice(0, secondIndex)) reducer.accept(event);
    expect(
      reducer.items
        .filter(({ item }) => item.type === "agentMessage")
        .map(({ item }) => (item.type === "agentMessage" ? item.text : "")),
    ).toEqual(["PROBE_ONE"]);
    const persisted = events.filter((event) => !event.ephemeral);
    const history = projectHistory(sessionId, persisted);
    expect(history.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual(
      users.map((event) => event.data.messageId),
    );
    expect(history.turns.every((turn) => turn.outcome.status === "unknown")).toBe(true);
    expect(projectHistory(sessionId, persisted)).toEqual(history);
    expect(forkBoundary(persisted, history.turns[0]?.nativeTurnRef.nativeTurnKey ?? "")).toBe(
      secondUser?.id,
    );
    expect(
      forkBoundary(persisted, history.turns[1]?.nativeTurnRef.nativeTurnKey ?? ""),
    ).toBeUndefined();
    expect(() => forkBoundary(persisted, "missing")).toThrow();
  });

  it("preserves native cancellation and subsequent successful content without inventing historical success", () => {
    const history = projectHistory(
      sessionId,
      fixture("lifecycle").filter((event) => !event.ephemeral),
    );
    expect(history.turns.map((turn) => turn.outcome.status)).toEqual(["cancelled", "unknown"]);
    expect(
      history.turns[1]?.items.some(
        ({ item }) => item.type === "agentMessage" && item.text === "AFTER_CANCEL",
      ),
    ).toBe(true);
  });

  it("retains native tools through cancelled approval/question lifecycles", () => {
    const history = projectHistory(
      sessionId,
      fixture("interaction").filter((event) => !event.ephemeral),
    );
    expect(history.turns.filter((turn) => turn.outcome.status === "cancelled")).toHaveLength(3);
    expect(
      history.turns.some((turn) => turn.items.some(({ item }) => item.type === "commandExecution")),
    ).toBe(true);
    expect(
      history.turns.some((turn) =>
        turn.items.some(
          ({ item }) => item.type === "toolExecution" && item.toolName === "ask_user",
        ),
      ),
    ).toBe(true);
  });

  it("rejects unidentifiable history and foreign/payload-bearing session references", () => {
    const user = rootMessages(fixture("basic"))[0];
    if (!user) throw new Error("Missing native fixture");
    const missing = structuredClone(user);
    delete missing.data.messageId;
    expect(() => projectHistory(sessionId, [missing])).toThrow(/identity/);
    const ref = sessionRef(sessionId);
    expect(sessionIdFromRef(ref)).toBe(sessionId);
    expect(() => sessionIdFromRef({ ...ref, locator: { storage: "other", version: 1 } })).toThrow();
    expect(() => sessionRef("../../other")).toThrow();
  });
});
