import { describe, expect, it } from "vitest";

import { clearInheritedForkInbox, pendingForkInboxIds } from "../../src/modern/fork-inbox.js";
import {
  ModernJournalError,
  type ModernJournal,
  type ModernJournalEvent,
  type ModernJournalRemote,
} from "../../src/modern/journal.js";
import { ModernRemoteConnectionError } from "../../src/modern/remote-connection.js";
import type { ModernRemoteResult } from "../../src/modern/wire.js";

function message(id: string, text = id) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user", rpcId: `request-${id}` },
  };
}

function splice(seq: number, inserted: unknown[]): ModernJournalEvent {
  return {
    seq,
    time: seq,
    type: "agent/inbox/spliced",
    data: { target: "next-turn", start: 0, inserted } as never,
  };
}

function journal(
  inbox: unknown = { "next-turn": [message("held")], "next-step": [] },
  extra: Partial<ModernJournal> = {},
): ModernJournal {
  return {
    header: { version: 3, id: "child", parentSession: "source", createdAt: 0, isSeeded: true },
    inheritedEventCount: 1,
    cursor: 1,
    events: [
      splice(0, [message("held")]),
      { seq: 1, time: 1, type: "session/end-seed", data: { inherited: true } },
    ],
    projections: { asOfSeq: 1, values: inbox === undefined ? {} : { inbox: inbox as never } },
    live: { async *[Symbol.asyncIterator]() {} },
    close: () => Promise.resolve(),
    ...extra,
  };
}

class Remote implements ModernJournalRemote {
  readonly calls: Array<{
    endpoint: string;
    args: Readonly<Record<string, unknown>>;
    signal: AbortSignal | undefined;
  }> = [];
  constructor(
    readonly response: () => ModernRemoteResult<unknown> = () => ({
      ok: true,
      value: { accepted: true },
    }),
  ) {}
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>> {
    this.calls.push({ endpoint, args, signal });
    return Promise.resolve().then(() => this.response() as ModernRemoteResult<T>);
  }
  openStream<T>(): AsyncIterable<T> {
    throw new Error("unexpected stream");
  }
}

describe("native V3 inherited fork inbox", () => {
  it("removes only verified inherited pending IDs from the child through durable queue RPCs", async () => {
    const first = message("held");
    const second = message("context");
    const input = journal(
      { "next-turn": [first], "next-step": [second] },
      { events: [splice(0, [first, second])] },
    );
    const before = JSON.stringify(input);
    const remote = new Remote();
    const signal = new AbortController().signal;
    expect(pendingForkInboxIds(input)).toEqual(["held", "context"]);
    await expect(clearInheritedForkInbox(remote, input, signal)).resolves.toBe(true);
    expect(remote.calls).toEqual(
      ["held", "context"].map((itemId) => ({
        endpoint: "session/updateQueue",
        args: { request: { sessionId: "child", itemId, action: { kind: "remove" } } },
        signal,
      })),
    );
    expect(JSON.stringify(input)).toBe(before);
    const reopened = journal(
      { "next-turn": [], "next-step": [] },
      { events: [...input.events, splice(1, [])] },
    );
    expect(pendingForkInboxIds(reopened)).toEqual([]);
    await expect(clearInheritedForkInbox(remote, reopened, signal)).resolves.toBe(false);
    expect(remote.calls).toHaveLength(2);
  });

  it("permits a missing projection only when the seed has no inbox splice", () => {
    const absent = { projections: { asOfSeq: -1, values: {} } };
    expect(
      pendingForkInboxIds(journal(undefined, { ...absent, events: [], inheritedEventCount: 0 })),
    ).toEqual([]);
    expect(() => pendingForkInboxIds(journal(undefined, absent))).toThrow(ModernJournalError);
    expect(() =>
      pendingForkInboxIds(journal(undefined, { ...absent, events: [splice(0, [])] })),
    ).toThrow(ModernJournalError);
    expect(() =>
      pendingForkInboxIds(
        journal(undefined, {
          ...absent,
          events: [splice(0, [message("external")])],
          inheritedEventCount: 0,
        }),
      ),
    ).toThrow(ModernJournalError);
  });

  it.each(
    [
      null,
      {},
      { "next-turn": [] },
      { "next-turn": {}, "next-step": [] },
      { "next-turn": [], "next-step": null },
      { "next-turn": [], "next-step": [], extra: true },
      { "next-turn": [null], "next-step": [] },
      { "next-turn": [{ ...message("held"), id: "" }], "next-step": [] },
      { "next-turn": [{ ...message("held"), role: "assistant" }], "next-step": [] },
      { "next-turn": [{ ...message("held"), content: "text" }], "next-step": [] },
      { "next-turn": [{ ...message("held"), source: { kind: "" } }], "next-step": [] },
      { "next-turn": [message("held")], "next-step": [message("held")] },
    ].map((value) => [value]),
  )("rejects malformed native inbox %j before any mutation", async (value) => {
    const remote = new Remote();
    await expect(
      clearInheritedForkInbox(remote, journal(value), new AbortController().signal),
    ).rejects.toBeInstanceOf(ModernJournalError);
    expect(remote.calls).toEqual([]);
  });

  it("refuses external input, including a new insertion or edit under an inherited ID", async () => {
    for (const input of [
      journal({ "next-turn": [message("held"), message("external")], "next-step": [] }),
      journal({ "next-turn": [message("held", "externally edited")], "next-step": [] }),
      journal(undefined, { events: [splice(0, [message("held")]), splice(1, [message("held")])] }),
    ]) {
      const remote = new Remote();
      await expect(
        clearInheritedForkInbox(remote, input, new AbortController().signal),
      ).rejects.toMatchObject({ code: "protocolError" });
      expect(remote.calls).toEqual([]);
    }
  });

  it("rejects a malformed seed boundary or inserted message", () => {
    const missingCount = { ...journal() };
    delete missingCount.inheritedEventCount;
    expect(() => pendingForkInboxIds(missingCount)).toThrow();
    for (const inheritedEventCount of [-1, 0.5, 3]) {
      expect(() => pendingForkInboxIds(journal(undefined, { inheritedEventCount }))).toThrow();
    }
    expect(() =>
      pendingForkInboxIds(journal(undefined, { events: [{ ...splice(0, []), data: null }] })),
    ).toThrow();
    expect(() =>
      pendingForkInboxIds(journal(undefined, { events: [splice(0, [null])] })),
    ).toThrow();
  });

  it.each([undefined, null, {}, { accepted: false }, { accepted: true, extra: true }])(
    "requires the exact native acknowledgement %j",
    async (value) => {
      const remote = new Remote(() => ({ ok: true, value }));
      await expect(
        clearInheritedForkInbox(remote, journal(), new AbortController().signal),
      ).rejects.toMatchObject({ code: "protocolError" });
      expect(remote.calls).toHaveLength(1);
    },
  );

  it("propagates native queue rejection without retrying", async () => {
    const remote = new Remote(() => ({
      ok: false,
      error: { code: "session/queue-item-not-found", message: "no longer pending", details: {} },
    }));
    await expect(
      clearInheritedForkInbox(remote, journal(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "remoteError", nativeCode: "session/queue-item-not-found" });
    expect(remote.calls).toHaveLength(1);
  });

  it.each([
    [new ModernRemoteConnectionError("processExited", "exited"), "processExited"],
    [new Error("broken"), "unavailable"],
  ])("normalizes transport failure %j without retries", async (error, code) => {
    const remote = new Remote(() => {
      throw error;
    });
    await expect(
      clearInheritedForkInbox(remote, journal(), new AbortController().signal),
    ).rejects.toMatchObject({ code });
    expect(remote.calls).toHaveLength(1);
  });

  it("honors cancellation before and during an operation", async () => {
    const controller = new AbortController();
    const remote = new Remote();
    controller.abort();
    await expect(
      clearInheritedForkInbox(remote, journal(), controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(remote.calls).toEqual([]);
    const during = new AbortController();
    const failed = new Remote(() => {
      during.abort();
      throw new Error("aborted");
    });
    await expect(clearInheritedForkInbox(failed, journal(), during.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(failed.calls).toHaveLength(1);
  });
});
