import { describe, expect, it } from "vitest";

import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import type { JsonObject, JsonValue } from "@codexhost/shared-contracts";

import type { OmoResponseFrame } from "../src/omo-protocol.js";
import { OmoRpcResponseError } from "../src/omo-rpc-session.js";
import {
  activeOmoEntries,
  mapOmoSnapshot,
  omoHistoryTurnKey,
  OmoHistoryProtocolError,
  readOmoHistory,
  readOmoSnapshot,
  resolveOmoForkBoundary,
  resolveOmoLastTurnBoundary,
  type OmoHistoryChannel,
  type OmoHistoryState,
  type OmoSessionHistory,
} from "../src/omo-history.js";

/**
 * Synthetic command channel answering `get_tree` and `get_entries` from an
 * in-memory history. Pages follow the documented contract: `since` is
 * exclusive, `limit` bounds the count, a page that is not the last carries
 * `hasMore: true` plus `nextSince` (the last entry id it returned).
 */
class FakeOmoHistoryChannel implements OmoHistoryChannel {
  readonly requests: Array<{ command: string; payload: Readonly<Record<string, unknown>> }> = [];
  readonly #refuse: (payload: Readonly<Record<string, unknown>>) => OmoRpcResponseError | undefined;
  #nextId = 0;

  constructor(
    readonly history: OmoSessionHistory,
    refuse?: (payload: Readonly<Record<string, unknown>>) => OmoRpcResponseError | undefined,
  ) {
    this.#refuse = refuse ?? (() => undefined);
  }

  send(
    command: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): Promise<OmoResponseFrame> {
    this.requests.push({ command, payload });
    if (command === "get_tree") {
      return Promise.resolve(
        this.#frame("get_tree", {
          tree: this.history.entries.length > 0 ? [{ entry: this.history.entries[0] }] : [],
          leafId: this.history.leafId,
        }),
      );
    }
    if (command !== "get_entries") {
      return Promise.reject(new Error(`Unexpected command '${command}'`));
    }
    const refusal = this.#refuse(payload);
    if (refusal) return Promise.reject(refusal);
    return Promise.resolve(this.#frame("get_entries", this.#page(payload)));
  }

  #frame(command: string, data: unknown): OmoResponseFrame {
    return {
      type: "response",
      id: `fake-${this.#nextId++}`,
      success: true,
      command,
      data,
    };
  }

  #page(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const since = typeof payload.since === "string" ? payload.since : undefined;
    const limit = typeof payload.limit === "number" ? payload.limit : Number.MAX_SAFE_INTEGER;
    const ids = this.history.entries.map((entry) => entry.id as string);
    const start = since === undefined ? 0 : ids.indexOf(since) + 1;
    const page = this.history.entries.slice(start, start + limit);
    const hasMore = start + page.length < this.history.entries.length;
    return {
      entries: page,
      hasMore,
      ...(hasMore && page.length > 0 ? { nextSince: page[page.length - 1]?.id } : {}),
    };
  }
}

/** A channel replaying scripted response frames, one per call. */
function scriptedChannel(...frames: unknown[]): OmoHistoryChannel & {
  requests: Array<{ command: string; payload: Readonly<Record<string, unknown>> }>;
} {
  const requests: Array<{ command: string; payload: Readonly<Record<string, unknown>> }> = [];
  let index = 0;
  return {
    requests,
    send(command: string, payload: Readonly<Record<string, unknown>> = {}) {
      requests.push({ command, payload });
      return Promise.resolve(frames[index++] as OmoResponseFrame);
    },
  };
}

function responseTooLarge(): OmoRpcResponseError {
  return new OmoRpcResponseError("get_entries", {
    type: "response",
    id: "refusal",
    success: false,
    errorCode: "response_too_large",
    error: "response too large",
  });
}

function userEntry(id: string, parentId: string | null, text: string, timestamp = 1): JsonObject {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-26T08:00:00.000Z",
    message: { role: "user", content: text, timestamp },
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  content: JsonValue,
  fields: JsonObject = {},
): JsonObject {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-26T08:00:02.000Z",
    message: { role: "assistant", content, ...fields },
  };
}

/**
 * Three Turns on the effective branch, one abandoned branch off a1, one
 * mid-branch fork off t2, a compaction and a model change inside Turn 2, a
 * bash tool call with result, and thinking content.
 */
const branchedHistory: OmoSessionHistory = {
  entries: [
    userEntry("u1", null, "first question", 1000),
    assistantEntry(
      "a1",
      "u1",
      [
        { type: "thinking", thinking: "considering the first question" },
        { type: "text", text: "first answer" },
      ],
      { stopReason: "stop", timestamp: 2000 },
    ),
    // Abandoned branch off a1: not on the leaf path.
    userEntry("ux", "a1", "abandoned question", 2500),
    assistantEntry("ax", "ux", [{ type: "text", text: "abandoned answer" }], {
      stopReason: "stop",
      timestamp: 2600,
    }),
    userEntry("u2", "a1", "second question", 5000),
    assistantEntry(
      "a2",
      "u2",
      [
        { type: "thinking", thinking: "checking the files" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "ls -la", cwd: "/tmp" },
        },
      ],
      { stopReason: "toolUse", timestamp: 6000 },
    ),
    {
      type: "message",
      id: "t2",
      parentId: "a2",
      timestamp: "2026-11-26T08:00:07.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "file-a\nfile-b" }],
        isError: false,
        timestamp: 7000,
      },
    },
    {
      type: "compaction",
      id: "cmp",
      parentId: "t2",
      timestamp: "2026-11-26T08:00:07.500Z",
      summary: "summarized earlier turns",
      firstKeptEntryId: "u2",
      tokensBefore: 9000,
    },
    {
      type: "model_change",
      id: "mch",
      parentId: "cmp",
      timestamp: "2026-11-26T08:00:08.000Z",
      provider: "provider-b",
      modelId: "model-b",
    },
    // Mid-branch fork off t2: its subtree must be excluded too.
    userEntry("f1", "t2", "mid-fork question", 6500),
    assistantEntry("f2", "f1", [{ type: "text", text: "fork answer" }], {
      stopReason: "stop",
      timestamp: 6600,
    }),
    userEntry("u3", "mch", "third question", 9000),
    assistantEntry("a3", "u3", [{ type: "text", text: "third answer" }], {
      stopReason: "stop",
      timestamp: 10000,
    }),
  ],
  leafId: "a3",
};

const branchedState: OmoHistoryState = {
  sessionId: "session-1",
  model: { provider: "provider-a", id: "model-a" },
  models: [
    { provider: "provider-a", id: "model-a" },
    { provider: "provider-b", id: "model-b" },
  ],
};

/** Turns of paired user/assistant entries; leafId is the last assistant. */
function linearHistory(turnCount: number): OmoSessionHistory {
  const entries: JsonObject[] = [];
  let parent: string | null = null;
  for (let index = 0; index < turnCount; index += 1) {
    entries.push(userEntry(`u${index}`, parent, `question ${index}`, index));
    entries.push(
      assistantEntry(`a${index}`, `u${index}`, [{ type: "text", text: `answer ${index}` }], {
        stopReason: "stop",
        timestamp: index,
      }),
    );
    parent = `a${index}`;
  }
  return { entries, leafId: `a${turnCount - 1}` };
}

function turnIdentity(snapshot: HostThreadSnapshot): string[][] {
  return snapshot.turns.map((turn) => [
    turn.nativeTurnRef.nativeTurnKey,
    ...turn.items.map((item) => item.item.itemId),
  ]);
}

describe("OmO history projection", () => {
  it("projects only the effective branch with exact Turn and Item identities", () => {
    const snapshot = mapOmoSnapshot(branchedHistory, branchedState);

    expect(snapshot.turns).toHaveLength(3);
    expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "turn:u1",
      "turn:u2",
      "turn:u3",
    ]);
    expect(snapshot.turns.map((turn) => turn.input)).toEqual([
      [{ type: "text", text: "first question" }],
      [{ type: "text", text: "second question" }],
      [{ type: "text", text: "third question" }],
    ]);
    expect(snapshot.turns.map((turn) => turn.checkpoint?.checkpointId)).toEqual(["u1", "u2", "u3"]);
    expect(snapshot.turns.map((turn) => turn.items.map((item) => item.item.itemId))).toEqual([
      ["omo-item-v1-a1-reasoning-0", "omo-item-v1-a1-assistant-0"],
      ["omo-item-v1-a2-reasoning-0", "omo-item-v1-a2-tool-1", "omo-item-v1-cmp-compaction-0"],
      ["omo-item-v1-a3-assistant-0"],
    ]);

    // Abandoned-branch and mid-fork entries project nowhere.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("abandoned");
    expect(serialized).not.toContain("mid-fork");
    expect(serialized).not.toContain("fork answer");
  });

  it("maps the bash tool pair to a commandExecution item with the turn outcome", () => {
    const snapshot = mapOmoSnapshot(branchedHistory, branchedState);
    const turn = snapshot.turns.at(1);
    const command = turn?.items.find((item) => item.item.type === "commandExecution");
    expect(command?.item).toEqual({
      type: "commandExecution",
      itemId: "omo-item-v1-a2-tool-1",
      command: "ls -la",
      cwd: "/tmp",
      output: "file-a\nfile-b",
    });
    expect(command?.outcome).toEqual({ status: "succeeded" });
    expect(turn?.outcome).toEqual({ status: "succeeded" });
  });

  it("projects compaction entries as contextCompaction items", () => {
    const snapshot = mapOmoSnapshot(branchedHistory, branchedState);
    const compaction = snapshot.turns
      .at(1)
      ?.items.find((item) => item.item.type === "contextCompaction");
    expect(compaction).toEqual({
      item: { type: "contextCompaction", itemId: "omo-item-v1-cmp-compaction-0" },
      outcome: { status: "succeeded" },
    });
  });

  it("carries the effective model per turn across model_change entries", () => {
    const snapshot = mapOmoSnapshot(branchedHistory, branchedState);
    expect(snapshot.turns.map((turn) => turn.model?.id)).toEqual([
      "provider-a/model-a",
      "provider-a/model-a",
      "provider-b/model-b",
    ]);
  });

  it("stamps turns from entry fields and omits completion for a reply-less turn", () => {
    const snapshot = mapOmoSnapshot(branchedHistory, branchedState);
    expect(snapshot.turns.map((turn) => turn.startedAtMs)).toEqual([1000, 5000, 9000]);
    expect(snapshot.turns.map((turn) => turn.completedAtMs)).toEqual([2000, 7000, 10000]);

    const pending: OmoSessionHistory = {
      entries: [userEntry("u1", null, "anyone there?", 42)],
      leafId: "u1",
    };
    const turn = mapOmoSnapshot(pending, { sessionId: "s" }).turns.at(0);
    expect(turn?.startedAtMs).toBe(42);
    expect(turn?.completedAtMs).toBeUndefined();
  });

  it("falls back to the entry's ISO stamp when the message carries no timestamp", () => {
    const iso = "2026-11-26T08:00:02.000Z";
    const history: OmoSessionHistory = {
      entries: [
        { ...userEntry("u1", null, "q", 1), timestamp: iso },
        assistantEntry("a1", "u1", [{ type: "text", text: "partial answer" }], {
          stopReason: "stop",
        }),
      ],
      leafId: "a1",
    };
    const turn = mapOmoSnapshot(history, { sessionId: "s" }).turns.at(0);
    expect(turn?.completedAtMs).toBe(Date.parse(iso));
  });

  it("produces identical identities across repeated projections", () => {
    const first = mapOmoSnapshot(branchedHistory, branchedState);
    const second = mapOmoSnapshot(branchedHistory, branchedState);
    expect(second).toEqual(first);
    expect(turnIdentity(second)).toEqual(turnIdentity(first));
  });

  it("uses entry ids verbatim, without hashing drift", () => {
    expect(omoHistoryTurnKey("u1")).toBe("turn:u1");
    const snapshot = mapOmoSnapshot(branchedHistory, branchedState);
    expect(snapshot.turns.at(0)?.nativeTurnRef).toEqual({
      harnessId: "omo",
      nativeSessionId: "session-1",
      nativeTurnKey: "turn:u1",
      formatVersion: 1,
    });
  });

  it("keeps identities stable across repeated channel reads", async () => {
    const first = await readOmoSnapshot(new FakeOmoHistoryChannel(branchedHistory), branchedState);
    const second = await readOmoSnapshot(new FakeOmoHistoryChannel(branchedHistory), branchedState);
    expect(turnIdentity(second)).toEqual(turnIdentity(first));
    expect(second).toEqual(first);
  });

  it("defaults a missing stopReason from persisted text, never inventing an outcome", () => {
    const history: OmoSessionHistory = {
      entries: [
        userEntry("u1", null, "what happened", 1),
        assistantEntry("a1", "u1", [{ type: "text", text: "partial answer" }]),
      ],
      leafId: "a1",
    };
    expect(mapOmoSnapshot(history, { sessionId: "s" }).turns.at(0)?.outcome).toEqual({
      status: "succeeded",
    });
  });

  it("marks a terminal without stopReason or text unknown", () => {
    const history: OmoSessionHistory = {
      entries: [userEntry("u1", null, "what happened", 1), assistantEntry("a1", "u1", [])],
      leafId: "a1",
    };
    expect(mapOmoSnapshot(history, { sessionId: "s" }).turns.at(0)?.outcome).toEqual({
      status: "unknown",
      reason: "OmO Assistant terminal is not classifiable",
    });
  });

  it("maps stopReason error to a failed outcome with the provider diagnostic", () => {
    const rateLimit: OmoSessionHistory = {
      entries: [
        userEntry("u1", null, "do the thing", 1),
        assistantEntry("a1", "u1", [], {
          stopReason: "error",
          errorMessage: "quota exceeded",
          providerDiagnostic: { category: "rate_limit", httpStatus: 429 },
        }),
      ],
      leafId: "a1",
    };
    expect(mapOmoSnapshot(rateLimit, { sessionId: "s" }).turns.at(0)?.outcome).toEqual({
      status: "failed",
      error: { code: "nativeFailure", message: "quota exceeded", retryable: false },
    });

    const auth: OmoSessionHistory = {
      entries: [
        userEntry("u1", null, "do the thing", 1),
        assistantEntry("a1", "u1", [], {
          stopReason: "error",
          providerDiagnostic: { category: "auth" },
        }),
      ],
      leafId: "a1",
    };
    expect(mapOmoSnapshot(auth, { sessionId: "s" }).turns.at(0)?.outcome).toEqual({
      status: "failed",
      error: { code: "authenticationRequired", message: "OmO Assistant failed", retryable: false },
    });
  });

  it("maps stopReason aborted to a cancelled outcome", () => {
    const history: OmoSessionHistory = {
      entries: [
        userEntry("u1", null, "do the thing", 1),
        assistantEntry("a1", "u1", [], { stopReason: "aborted" }),
      ],
      leafId: "a1",
    };
    expect(mapOmoSnapshot(history, { sessionId: "s" }).turns.at(0)?.outcome).toEqual({
      status: "cancelled",
      reason: "OmO Assistant was aborted",
    });
  });

  it("projects tool, mcp, and shell-alias tool pairs; unmatched pairs produce no item", () => {
    const history: OmoSessionHistory = {
      entries: [
        userEntry("u1", null, "read edit and write", 1),
        assistantEntry(
          "a1",
          "u1",
          [
            { type: "toolCall", id: "call-read", name: "read", arguments: { path: "a.txt" } },
            {
              type: "toolCall",
              id: "call-mcp",
              name: "mcp__server1__Edit",
              arguments: { file: "x" },
            },
            {
              type: "toolCall",
              id: "call-exec",
              name: "exec",
              arguments: { script: "git status" },
            },
            { type: "toolCall", id: "call-write", name: "write", arguments: { path: "b.txt" } },
          ],
          { stopReason: "toolUse" },
        ),
        {
          type: "message",
          id: "t-read",
          parentId: "a1",
          timestamp: "2026-11-26T08:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "a-contents" }],
            isError: false,
          },
        },
        {
          type: "message",
          id: "t-mcp",
          parentId: "t-read",
          timestamp: "2026-11-26T08:00:04.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-mcp",
            toolName: "mcp__server1__Edit",
            content: [{ type: "text", text: "edit failed" }],
            isError: true,
          },
        },
        {
          type: "message",
          id: "t-exec",
          parentId: "t-mcp",
          timestamp: "2026-11-26T08:00:05.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-exec",
            toolName: "exec",
            content: [{ type: "text", text: "nothing to commit" }],
            isError: false,
          },
        },
        {
          type: "message",
          id: "t-orphan",
          parentId: "t-exec",
          timestamp: "2026-11-26T08:00:06.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-unknown",
            toolName: "read",
            content: [{ type: "text", text: "orphan result" }],
            isError: false,
          },
        },
        assistantEntry("a2", "t-orphan", [{ type: "text", text: "done" }], { stopReason: "stop" }),
      ],
      leafId: "a2",
    };
    const items = mapOmoSnapshot(history, { sessionId: "s" }).turns.at(0)?.items ?? [];

    // read (toolExecution), mcp (failed), exec (commandExecution); write has no
    // result and the orphan result has no call, so neither projects.
    expect(items.map((item) => [item.item.type, item.item.itemId])).toEqual([
      ["toolExecution", "omo-item-v1-a1-tool-0"],
      ["mcpToolCall", "omo-item-v1-a1-tool-1"],
      ["commandExecution", "omo-item-v1-a1-tool-2"],
      ["agentMessage", "omo-item-v1-a2-assistant-0"],
    ]);
    expect(items.at(0)?.item).toEqual({
      type: "toolExecution",
      itemId: "omo-item-v1-a1-tool-0",
      toolName: "read",
      arguments: { path: "a.txt" },
      output: { content: [{ type: "text", text: "a-contents" }] },
    });
    expect(items.at(1)?.item).toEqual({
      type: "mcpToolCall",
      itemId: "omo-item-v1-a1-tool-1",
      server: "server1",
      tool: "Edit",
      arguments: { file: "x" },
      output: { content: [{ type: "text", text: "edit failed" }] },
    });
    expect(items.at(1)?.outcome).toEqual({
      status: "failed",
      error: {
        code: "nativeFailure",
        message: "OmO Tool 'mcp__server1__Edit' failed",
        retryable: false,
      },
    });
    expect(items.at(2)?.item).toEqual({
      type: "commandExecution",
      itemId: "omo-item-v1-a1-tool-2",
      command: "git status",
      output: "nothing to commit",
    });
  });

  it("projects an eval tool pair as a commandExecution carrying the executed code", () => {
    // Real 5.1.83 routes shell commands through the `eval` tool whose arguments
    // carry {language, code, summary} (task-9 trace); the history projection
    // must route it exactly like the live one.
    const history: OmoSessionHistory = {
      entries: [
        userEntry("u1", null, "run the check", 1),
        assistantEntry(
          "a1",
          "u1",
          [
            {
              type: "toolCall",
              id: "call-eval-1",
              name: "eval",
              arguments: {
                language: "js",
                code: 'const r = await tool.bash({ command: "npm test" });',
                summary: "Running the test suite",
              },
            },
          ],
          { stopReason: "toolUse" },
        ),
        {
          type: "message",
          id: "t-eval",
          parentId: "a1",
          timestamp: "2026-11-26T08:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-eval-1",
            toolName: "eval",
            content: [{ type: "text", text: "all tests passed" }],
            isError: false,
          },
        },
        assistantEntry("a2", "t-eval", [{ type: "text", text: "done" }], { stopReason: "stop" }),
      ],
      leafId: "a2",
    };
    const items = mapOmoSnapshot(history, { sessionId: "s" }).turns.at(0)?.items ?? [];
    const command = items.find((item) => item.item.type === "commandExecution");
    expect(command?.item).toEqual({
      type: "commandExecution",
      itemId: "omo-item-v1-a1-tool-0",
      command: 'const r = await tool.bash({ command: "npm test" });',
      output: "all tests passed",
    });
    expect(items.some((item) => item.item.type === "toolExecution")).toBe(false);
  });

  it("requires a session id for the projection", () => {
    expect(() => mapOmoSnapshot(branchedHistory, { sessionId: "" })).toThrowError(
      OmoHistoryProtocolError,
    );
    expect(() => mapOmoSnapshot(branchedHistory, { sessionId: "" })).toThrowError(/Session id/);
  });
});

describe("OmO history tree validation", () => {
  it("rejects a cycle on the effective branch with a typed protocol error", () => {
    const cyclic: OmoSessionHistory = {
      entries: [
        { type: "message", id: "a", parentId: "b", message: { role: "user", content: "x" } },
        { type: "message", id: "b", parentId: "a", message: { role: "user", content: "y" } },
      ],
      leafId: "a",
    };
    expect(() => mapOmoSnapshot(cyclic, { sessionId: "s" })).toThrowError(OmoHistoryProtocolError);
    expect(() => mapOmoSnapshot(cyclic, { sessionId: "s" })).toThrowError(/cycle/);
  });

  it("rejects a missing parent on the effective branch", () => {
    const orphaned: OmoSessionHistory = {
      entries: [
        { type: "message", id: "a", parentId: "missing", message: { role: "user", content: "x" } },
      ],
      leafId: "a",
    };
    expect(() => mapOmoSnapshot(orphaned, { sessionId: "s" })).toThrowError(
      OmoHistoryProtocolError,
    );
    expect(() => mapOmoSnapshot(orphaned, { sessionId: "s" })).toThrowError(/missing Entry/);
  });

  it("rejects duplicate entry ids", () => {
    const duplicated: OmoSessionHistory = {
      entries: [
        { type: "message", id: "a", parentId: null, message: { role: "user", content: "x" } },
        { type: "message", id: "a", parentId: null, message: { role: "user", content: "y" } },
      ],
      leafId: "a",
    };
    expect(() => mapOmoSnapshot(duplicated, { sessionId: "s" })).toThrowError(
      OmoHistoryProtocolError,
    );
    expect(() => mapOmoSnapshot(duplicated, { sessionId: "s" })).toThrowError(/repeats/);
  });

  it("rejects a leaf no entry provides", () => {
    const missing: OmoSessionHistory = { entries: [], leafId: "ghost" };
    expect(() => mapOmoSnapshot(missing, { sessionId: "s" })).toThrowError(OmoHistoryProtocolError);
    expect(() => mapOmoSnapshot(missing, { sessionId: "s" })).toThrowError(/missing Entry/);
  });

  it("rejects an invalid entry identity", () => {
    const invalid: OmoSessionHistory = {
      entries: [{ type: "message", id: "", parentId: null }],
      leafId: "",
    };
    expect(() => mapOmoSnapshot(invalid, { sessionId: "s" })).toThrowError(OmoHistoryProtocolError);
    expect(() => mapOmoSnapshot(invalid, { sessionId: "s" })).toThrowError(
      /invalid Entry identity/,
    );
  });

  it("returns no entries for a session with a null leaf", () => {
    expect(activeOmoEntries({ entries: branchedHistory.entries, leafId: null })).toEqual([]);
  });
});

describe("OmO history paging", () => {
  it("assembles a multi-page history with bounded requests", async () => {
    const history = linearHistory(350);
    const channel = new FakeOmoHistoryChannel(history);
    const assembled = await readOmoHistory(channel);

    expect(assembled.entries).toHaveLength(700);
    expect(assembled.entries.at(0)?.id).toBe("u0");
    expect(assembled.entries.at(699)?.id).toBe("a349");
    expect(assembled.leafId).toBe("a349");
    expect(channel.requests.map((request) => request.command)).toEqual([
      "get_tree",
      "get_entries",
      "get_entries",
    ]);
    expect(channel.requests.at(1)?.payload).toEqual({ limit: 500, maxBytes: 8_388_608 });
    expect(channel.requests.at(2)?.payload).toEqual({
      limit: 500,
      maxBytes: 8_388_608,
      since: "a249",
    });

    const snapshot = mapOmoSnapshot(assembled, { sessionId: "s" });
    expect(snapshot.turns).toHaveLength(350);
    expect(snapshot.turns.at(0)?.nativeTurnRef.nativeTurnKey).toBe("turn:u0");
    expect(snapshot.turns.at(349)?.nativeTurnRef.nativeTurnKey).toBe("turn:u349");
  });

  it("reads an empty history in one bounded page", async () => {
    const channel = new FakeOmoHistoryChannel({ entries: [], leafId: null });
    const assembled = await readOmoHistory(channel);
    expect(assembled).toEqual({ entries: [], leafId: null });
    expect(channel.requests).toHaveLength(2);
  });

  it("shrinks the page on response_too_large and retries", async () => {
    const channel = new FakeOmoHistoryChannel(linearHistory(3), (payload) => {
      const limit = payload.limit;
      return typeof limit === "number" && limit > 10 ? responseTooLarge() : undefined;
    });
    const assembled = await readOmoHistory(channel);

    expect(assembled.entries).toHaveLength(6);
    const limits = channel.requests
      .filter((request) => request.command === "get_entries")
      .map((request) => request.payload.limit);
    expect(limits).toEqual([500, 250, 125, 62, 31, 15, 7]);
  });

  it("terminates with a typed error when no page can carry the history", async () => {
    const channel = new FakeOmoHistoryChannel(linearHistory(1), () => responseTooLarge());
    await expect(readOmoHistory(channel)).rejects.toBeInstanceOf(OmoHistoryProtocolError);
    const last = channel.requests
      .filter((request) => request.command === "get_entries")
      .at(-1)?.payload;
    expect(last).toEqual({ limit: 1, maxBytes: 48 * 1024 * 1024 });
  });

  it("propagates native refusals that are not response_too_large", async () => {
    const refusal = new OmoRpcResponseError("get_entries", {
      type: "response",
      id: "refusal",
      success: false,
      errorCode: "not_found",
    });
    const channel = new FakeOmoHistoryChannel(linearHistory(1), () => refusal);
    await expect(readOmoHistory(channel)).rejects.toBe(refusal);
  });

  it("rejects a malformed get_tree answer", async () => {
    const channel = scriptedChannel({
      type: "response",
      id: "t1",
      success: true,
      command: "get_tree",
      data: { leafId: "a1" },
    });
    await expect(readOmoHistory(channel)).rejects.toThrowError(/tree array/);
  });

  it("rejects a page without a hasMore flag", async () => {
    const channel = scriptedChannel(
      {
        type: "response",
        id: "t1",
        success: true,
        command: "get_tree",
        data: { tree: [], leafId: null },
      },
      {
        type: "response",
        id: "e1",
        success: true,
        command: "get_entries",
        data: { entries: [] },
      },
    );
    await expect(readOmoHistory(channel)).rejects.toThrowError(/hasMore/);
  });

  it("rejects a page that reports more but returns nothing", async () => {
    const channel = scriptedChannel(
      {
        type: "response",
        id: "t1",
        success: true,
        command: "get_tree",
        data: { tree: [], leafId: null },
      },
      {
        type: "response",
        id: "e1",
        success: true,
        command: "get_entries",
        data: { entries: [], hasMore: true, nextSince: "a1" },
      },
    );
    await expect(readOmoHistory(channel)).rejects.toThrowError(/forward progress/);
  });

  it("rejects a page that repeats its cursor", async () => {
    const entry = userEntry("u1", null, "q");
    const page = {
      type: "response",
      id: "e1",
      success: true,
      command: "get_entries",
      data: { entries: [entry], hasMore: true, nextSince: "u1" },
    };
    const channel = scriptedChannel(
      {
        type: "response",
        id: "t1",
        success: true,
        command: "get_tree",
        data: { tree: [], leafId: "u1" },
      },
      page,
      page,
    );
    await expect(readOmoHistory(channel)).rejects.toThrowError(/forward progress/);
  });

  it("rejects a non-object entry in a page", async () => {
    const channel = scriptedChannel(
      {
        type: "response",
        id: "t1",
        success: true,
        command: "get_tree",
        data: { tree: [], leafId: null },
      },
      {
        type: "response",
        id: "e1",
        success: true,
        command: "get_entries",
        data: { entries: ["not an object"], hasMore: false },
      },
    );
    await expect(readOmoHistory(channel)).rejects.toThrowError(/non-object Entry/);
  });
});

describe("OmO readOmoSnapshot", () => {
  it("reads the tree first, then projects through the channel", async () => {
    const channel = new FakeOmoHistoryChannel(branchedHistory);
    const snapshot = await readOmoSnapshot(channel, branchedState);

    expect(channel.requests.at(0)?.command).toBe("get_tree");
    expect(snapshot.turns).toHaveLength(3);
    expect(snapshot.turns.at(2)?.nativeTurnRef).toEqual({
      harnessId: "omo",
      nativeSessionId: "session-1",
      nativeTurnKey: "turn:u3",
      formatVersion: 1,
    });
  });

  it("exposes a protocolError code for the session's error mapping", () => {
    const error = new OmoHistoryProtocolError("broken");
    expect(error.code).toBe("protocolError");
  });
});

describe("OmO derivation boundaries", () => {
  it("rolls back the last Turn of the effective branch and keeps the prefix", () => {
    expect(resolveOmoLastTurnBoundary(branchedHistory)).toEqual({
      boundaryEntryId: "u3",
      retainedTurnKeys: ["turn:u1", "turn:u2"],
    });
    expect(resolveOmoLastTurnBoundary(linearHistory(1))).toEqual({
      boundaryEntryId: "u0",
      retainedTurnKeys: [],
    });
    expect(resolveOmoLastTurnBoundary({ entries: [], leafId: null })).toBeNull();
  });

  it("ignores abandoned branches when planning a rollback", () => {
    // leafId a1 leaves only the first Turn active; ux and u2 are off-branch.
    const history: OmoSessionHistory = {
      entries: [
        userEntry("u1", null, "first", 1),
        assistantEntry("a1", "u1", [{ type: "text", text: "answer" }], {
          stopReason: "stop",
          timestamp: 2,
        }),
        userEntry("ux", "a1", "abandoned", 3),
      ],
      leafId: "a1",
    };
    expect(resolveOmoLastTurnBoundary(history)).toEqual({
      boundaryEntryId: "u1",
      retainedTurnKeys: [],
    });
  });

  it("plans a Fork at a middle Checkpoint with the next user entry as boundary", () => {
    expect(resolveOmoForkBoundary(branchedHistory, "u1")).toEqual({
      targetTurnIndex: 0,
      boundaryEntryId: "u2",
      retainedTurnKeys: ["turn:u1"],
    });
    expect(resolveOmoForkBoundary(branchedHistory, "u2")).toEqual({
      targetTurnIndex: 1,
      boundaryEntryId: "u3",
      retainedTurnKeys: ["turn:u1", "turn:u2"],
    });
  });

  it("plans a tip Fork on the startup copy because no next user entry exists", () => {
    expect(resolveOmoForkBoundary(branchedHistory, "u3")).toEqual({
      targetTurnIndex: 2,
      boundaryEntryId: null,
      retainedTurnKeys: ["turn:u1", "turn:u2", "turn:u3"],
    });
  });

  it("rejects a Checkpoint off the active branch", () => {
    expect(() => resolveOmoForkBoundary(branchedHistory, "ux")).toThrowError(
      /not on the Session's active branch/u,
    );
    expect(() => resolveOmoForkBoundary(branchedHistory, "missing")).toThrowError(
      OmoHistoryProtocolError,
    );
  });
});
