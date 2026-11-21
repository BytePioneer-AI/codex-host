import { describe, expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { REASONING_TRANSCRIPT_COMMAND } from "@codexhost/shared-contracts";

import { reconcileExternalTurnItemIds } from "../src/external-turn-item-ids.js";

const answer = (id: string, text = "ok") => ({ id, type: "agentMessage", text });
const user = (id: string) => ({ id, type: "userMessage", content: [{ type: "text", text: "go" }] });
const summary = (id: string, text: string) => ({
  id: `${id}-summary`,
  type: "reasoning",
  summary: [text],
  content: [],
});
const transcript = (id: string, text: string) => ({
  id,
  type: "commandExecution",
  command: REASONING_TRANSCRIPT_COMMAND,
  aggregatedOutput: text,
});
const thinking = (id: string, text: string) => [summary(id, text), transcript(id, text)];
const turn = (...items: JsonObject[]) => ({ id: "turn", items });

function reconcile(previous: JsonObject[], history: JsonObject[]) {
  return reconcileExternalTurnItemIds([turn(...previous)], [turn(...history)])[0]?.items;
}

function ids(items: JsonObject[], history: JsonObject[]) {
  return (reconcile(items, history) as JsonObject[]).map(({ id }) => id);
}

describe("external Turn Item ID reconciliation", () => {
  it("preserves live IDs and keeps native Turn order, content, outcome, timing and phase across refreshes", () => {
    const live = {
      ...turn(user("turn-user"), ...thinking("live-r", "working\n"), answer("live-a", "done")),
      status: "completed",
    };
    const native = {
      ...turn(
        { ...user("turn-user"), clientId: null },
        summary("native-r", "working"),
        { ...transcript("native-r", "working"), status: "completed", durationMs: 37 },
        { ...answer("native-a", "done\n"), phase: "final_answer" },
      ),
      status: "interrupted",
      durationMs: 71,
      codexhostFileOperations: [
        { beforeItemId: "native-r-summary", item: { id: "native-edit", type: "fileChange" } },
      ],
    };
    const added = { ...turn(answer("new-turn-answer")), id: "new-turn" };
    const retained = { ...turn(answer("stable")), id: "retained" };
    const refreshed = [native, added, retained];
    const result = reconcileExternalTurnItemIds([retained, { id: "removed" }, live], refreshed);
    expect(result).toEqual([
      {
        ...native,
        items: [
          { ...user("turn-user"), clientId: null },
          summary("live-r", "working"),
          { ...transcript("live-r", "working"), status: "completed", durationMs: 37 },
          { ...answer("live-a", "done\n"), phase: "final_answer" },
        ],
        codexhostFileOperations: [
          { beforeItemId: "live-r-summary", item: { id: "native-edit", type: "fileChange" } },
        ],
      },
      added,
      retained,
    ]);
    expect(reconcileExternalTurnItemIds(result, refreshed)).toEqual(result);
    expect(native.items.map(({ id }) => id)).toEqual([
      "turn-user",
      "native-r-summary",
      "native-r",
      "native-a",
    ]);
  });

  it("uses one live ID per occurrence of identical text, but leaves unequal repeats alone", () => {
    const live = [answer("live-1"), answer("live-2")];
    const history = [answer("native-1"), answer("native-2")];
    expect(ids(live, history)).toEqual(["live-1", "live-2"]);
    expect(ids(live, [...history, answer("native-3")])).toEqual([
      "native-1",
      "native-2",
      "native-3",
    ]);
  });

  it("anchors on stable IDs before matching and never matches backwards across an anchor", () => {
    const stable = {
      id: "tool",
      type: "mcpToolCall",
      server: "fs",
      tool: "read",
      arguments: { path: "a" },
    };
    const live = [answer("before"), stable, answer("after", "later")];
    const history = [
      { ...stable, status: "completed" },
      answer("native-1"),
      answer("native-2", "later"),
    ];
    expect(reconcile(live, history)).toEqual([
      history[0],
      answer("native-1"),
      answer("after", "later"),
    ]);
  });

  it("keeps unrelated and merged Items native while preserving an unambiguous match", () => {
    expect(
      ids(
        [
          user("live-user"),
          ...thinking("live-r-1", "one"),
          ...thinking("live-r-2", "two"),
          answer("live-a"),
        ],
        [
          user("native-user"),
          ...thinking("native-r", "one\ntwo"),
          answer("native-extra", "unseen"),
          answer("native-a"),
        ],
      ),
    ).toEqual(["native-user", "native-r-summary", "native-r", "native-extra", "live-a"]);
    expect(
      ids(
        [answer("live-1", "one"), answer("live-2", "two")],
        [answer("native-2", "two"), answer("native-1", "one")],
      ),
    ).toEqual(["native-2", "native-1"]);
  });

  it.each<[JsonObject[], JsonObject[], string[]]>([
    [[summary("live-r", "working")], thinking("native-r", "working"), ["live-r-summary", "live-r"]],
    [thinking("live-r", "working"), [transcript("native-r", "working")], ["live-r"]],
    [[transcript("live-r", "working")], [summary("native-r", "working")], ["live-r-summary"]],
  ])(
    "preserves reasoning identity when a projection omits a twin ($2)",
    (live, history, expected) => {
      expect(ids(live, history)).toEqual(expected);
    },
  );

  it("does not move either reasoning ID if a twin is already anchored or its destination is reserved", () => {
    expect(
      ids(thinking("live-r", "working"), [
        ...thinking("native-r", "working"),
        { ...answer("live-r-summary", "unrelated"), type: "contextCompaction" },
      ]),
    ).toEqual(["native-r-summary", "native-r", "live-r-summary"]);
    expect(
      ids(thinking("live-r", "working"), [
        summary("live-r", "working"),
        ...thinking("native-r", "working"),
      ]),
    ).toEqual(["live-r-summary", "native-r-summary", "native-r"]);
    // Even an absent summary must not claim the ID of an unrelated native Item.
    expect(
      ids(
        [transcript("live-r", "working")],
        [transcript("native-r", "working"), answer("live-r-summary", "unrelated")],
      ),
    ).toEqual(["native-r", "live-r-summary"]);
  });

  it("uses native text for media-projected answers without changing their rewritten text", () => {
    const live = {
      ...answer("live-a", "![plot](live-url)"),
      codexhostNativeText: "![plot](plot.png)",
    };
    const native = {
      ...answer("native-a", "![plot](history-url)"),
      codexhostNativeText: "![plot](plot.png)\n",
    };
    expect(reconcile([live], [native])).toEqual([{ ...native, id: "live-a" }]);
    expect(reconcile([answer("live-a", live.text)], [native])).toEqual([native]);
  });

  it("requires structural evidence for tool Items, allowing native output and status to change", () => {
    const command = { type: "commandExecution", command: "ls", cwd: "/project" };
    const tool = { type: "mcpToolCall", server: "fs", tool: "read" };
    const native = [
      { ...command, id: "native-command", cwd: "/other" },
      { ...tool, id: "native-tool", arguments: { path: "a", lines: 10 }, status: "completed" },
    ];
    expect(
      reconcile(
        [
          { ...command, id: "live-command" },
          { ...tool, id: "live-tool", arguments: { lines: 10, path: "a" }, status: "inProgress" },
        ],
        native,
      ),
    ).toEqual([native[0], { ...native[1], id: "live-tool" }]);
  });
});
