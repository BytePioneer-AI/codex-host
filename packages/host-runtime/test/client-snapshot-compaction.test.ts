import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  SNAPSHOT_TOOL_OUTPUT_LIMIT,
  SNAPSHOT_TOOL_OUTPUT_PREVIEW,
  compactClientSnapshot,
} from "../src/client-snapshot-compaction.js";

type Turn = ClientThreadSnapshot["turnsPage"]["data"][number];

const big = "x".repeat(SNAPSHOT_TOOL_OUTPUT_LIMIT + 1);
function command(id: string, output: string, status = "completed") {
  return { id, type: "commandExecution", command: "ls", status, aggregatedOutput: output };
}
function turn(id: string, items: Turn["items"] = [], status = "completed"): Turn {
  return { id, status, items: [{ id: `u-${id}`, type: "userMessage" }, ...items] };
}
function snapshot(
  turns: Turn[],
  overrides: Partial<ClientThreadSnapshot> = {},
): ClientThreadSnapshot {
  return {
    cursor: { epoch: "epoch-1", sequence: 7 },
    activeTurnId: null,
    thread: { id: "thread" },
    turnsPage: { data: turns, nextCursor: null },
    configuration: {},
    queue: undefined,
    interactions: [],
    ...overrides,
  } as unknown as ClientThreadSnapshot;
}

describe("client snapshot compaction", () => {
  it("returns the same snapshot object when the request opts into nothing", () => {
    const input = snapshot([turn("a", [command("c", big)])]);
    expect(compactClientSnapshot(input, {})).toBe(input);
  });

  it("fingerprints settled Turns when knownTurns is present, even if empty", () => {
    const out = compactClientSnapshot(snapshot([turn("a"), turn("b")]), { knownTurns: [] });
    expect(out.turnsPage.data.map((value) => typeof value.fingerprint)).toEqual([
      "string",
      "string",
    ]);
    expect(out.turnsPage.data.every((value) => value.unchanged === undefined)).toBe(true);
    expect(out.turnsPage.data[0]?.items).toHaveLength(1);
  });

  it("replaces a matching Turn with an ordered placeholder and still sends changed Turns", () => {
    const input = snapshot([turn("c"), turn("b"), turn("a")]);
    const first = compactClientSnapshot(input, { knownTurns: [] }).turnsPage.data;
    const known = (id: string) => ({
      id,
      fingerprint: first.find((value) => value.id === id)?.fingerprint ?? "",
    });
    const changed = snapshot([
      turn("d", [command("c", "new")]),
      turn("c"),
      turn("b", [command("c", "edited")]),
      turn("a"),
    ]);
    const out = compactClientSnapshot(changed, {
      knownTurns: [known("a"), known("b"), known("c")],
    }).turnsPage.data;
    expect(out.map((value) => value.id)).toEqual(["d", "c", "b", "a"]);
    expect(out.map((value) => value.unchanged === true)).toEqual([false, true, false, true]);
    expect(out[1]).toEqual({
      id: "c",
      status: "completed",
      items: [],
      fingerprint: known("c").fingerprint,
      unchanged: true,
    });
    expect(out[2]?.items).toHaveLength(2);
  });

  it("never matches a fingerprint from another epoch or a wrong fingerprint", () => {
    const input = snapshot([turn("a")]);
    const old = compactClientSnapshot(input, { knownTurns: [] }).turnsPage.data[0];
    const next = compactClientSnapshot(
      snapshot([turn("a")], { cursor: { epoch: "epoch-2", sequence: 0 } }),
      { knownTurns: [{ id: "a", fingerprint: old?.fingerprint ?? "" }] },
    ).turnsPage.data[0];
    expect(next?.unchanged).toBeUndefined();
    expect(next?.items).toHaveLength(1);
    expect(next?.fingerprint).not.toBe(old?.fingerprint);
    const wrong = compactClientSnapshot(input, {
      knownTurns: [{ id: "a", fingerprint: "stale" }],
    }).turnsPage.data[0];
    expect(wrong?.unchanged).toBeUndefined();
  });

  it("always sends the active and in-progress Turns in full", () => {
    const live = turn("live", [command("c", "partial", "inProgress")], "inProgress");
    const settledWhileActive = turn("active", [command("c", "out")]);
    const input = snapshot([live, settledWhileActive], { activeTurnId: "active" });
    const out = compactClientSnapshot(input, {
      knownTurns: [
        { id: "live", fingerprint: "x" },
        { id: "active", fingerprint: "x" },
      ],
      truncateToolOutput: true,
    }).turnsPage.data;
    expect(out).toEqual(input.turnsPage.data);
  });

  it("shortens long tool output only on opt-in and records original lengths", () => {
    const input = snapshot([
      turn("a", [
        command("short", "ok"),
        command("long", big),
        command("running", big, "inProgress"),
        { id: "m", type: "agentMessage", text: big },
        {
          id: "f",
          type: "fileChange",
          status: "completed",
          changes: [
            { path: "a.ts", diff: "small" },
            { path: "b.ts", diff: big + "y" },
          ],
        },
      ]),
    ]);
    expect(compactClientSnapshot(input, {})).toBe(input);
    const items = compactClientSnapshot(input, { truncateToolOutput: true }).turnsPage.data[0]
      ?.items as Array<Record<string, unknown>>;
    expect(items.find((item) => item.id === "short")).toEqual(command("short", "ok"));
    const long = items.find((item) => item.id === "long");
    expect((long?.aggregatedOutput as string).length).toBe(SNAPSHOT_TOOL_OUTPUT_PREVIEW);
    expect(long?.codexhostTruncated).toEqual({
      fields: [{ path: ["aggregatedOutput"], originalLength: big.length }],
    });
    expect(items.find((item) => item.id === "running")).toEqual(
      command("running", big, "inProgress"),
    );
    expect(items.find((item) => item.id === "m")).toEqual({
      id: "m",
      type: "agentMessage",
      text: big,
    });
    const file = items.find((item) => item.id === "f");
    expect(file?.codexhostTruncated).toEqual({
      fields: [{ path: ["changes", 1, "diff"], originalLength: big.length + 1 }],
    });
    expect((file?.changes as Array<{ diff: string }>)[0]?.diff).toBe("small");
    // The input snapshot is not mutated.
    const original = input.turnsPage.data[0]?.items.find((item) => item.id === "long");
    expect((original?.aggregatedOutput as string).length).toBe(big.length);
  });

  it("does not split a surrogate pair at the preview boundary", () => {
    const text =
      "a".repeat(SNAPSHOT_TOOL_OUTPUT_PREVIEW - 1) + "😀" + "b".repeat(SNAPSHOT_TOOL_OUTPUT_LIMIT);
    const out = compactClientSnapshot(snapshot([turn("a", [command("c", text)])]), {
      truncateToolOutput: true,
    });
    const shortened = (out.turnsPage.data[0]?.items[1] as unknown as { aggregatedOutput: string })
      .aggregatedOutput;
    expect(shortened).toBe("a".repeat(SNAPSHOT_TOOL_OUTPUT_PREVIEW - 1));
  });

  it("fingerprints the served form, so toggling truncation changes the fingerprint", () => {
    const input = snapshot([turn("a", [command("c", big)])]);
    const full = compactClientSnapshot(input, { knownTurns: [] }).turnsPage.data[0];
    const cut = compactClientSnapshot(input, { knownTurns: [], truncateToolOutput: true }).turnsPage
      .data[0];
    expect(cut?.fingerprint).not.toBe(full?.fingerprint);
    const again = compactClientSnapshot(input, {
      knownTurns: [{ id: "a", fingerprint: cut?.fingerprint ?? "" }],
      truncateToolOutput: true,
    }).turnsPage.data[0];
    expect(again?.unchanged).toBe(true);
  });
});
