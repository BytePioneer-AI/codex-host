import { expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import { SessionManager } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/manager.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";
import type {
  SessionFollowFrame,
  SessionFollowRequest,
} from "../../../apps/web-ui/packages/api/session-controller/src/types.ts";

function fixture() {
  const closed: string[] = [];
  const gates = new Map<string, Promise<unknown>>();
  const content = new Map<string, string>();
  const online = { generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } };
  const fork = vi.fn(async () => ({ ok: true, value: { sessionId: SessionId("child") } }));
  const remote = {
    $stream: (options: ConstructorParameters<typeof RemoteStream>[1]) =>
      new RemoteStream(online as never, options),
    session: {
      fork,
      async *follow(request: SessionFollowRequest, signal: AbortSignal) {
        const id =
          request.address.kind === "session"
            ? request.address.sessionId
            : request.address.childSessionId;
        try {
          if (gates.has(id))
            await Promise.race([
              gates.get(id),
              new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              ),
            ]);
          if (signal.aborted) return;
          yield {
            type: "snapshot",
            header: { version: 4, id, createdAt: 1, isSeeded: false },
            cursor: 0,
            records: [
              {
                type: "event",
                event: {
                  type: "test/content",
                  seq: 0,
                  time: 1,
                  data: { text: content.get(id) ?? id },
                  ignorable: true,
                },
              },
            ],
            hasMore: true,
            projections: {
              asOfSeq: 0,
              values: { codexhostToolOutput: { command: content.get(id) ?? id } },
            },
            assistantStream: { revision: 0 },
          } as unknown as SessionFollowFrame;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        } finally {
          closed.push(id);
        }
      },
    },
  } as unknown as SessionRemotes;
  return { manager: new SessionManager(remote), gates, content, closed, fork };
}

it("shows detached cached data before follow opens, then replaces it with the authoritative snapshot", async () => {
  const { manager, content, gates, closed, fork } = fixture();
  const id = SessionId("a");
  const old = manager.get(id);
  await old.open();
  await manager.drop(id, old);
  expect(closed).toEqual([id]);
  content.set(id, "authoritative replacement");
  const gate = Promise.withResolvers<undefined>();
  gates.set(id, gate.promise);
  const restored = manager.get(id);
  expect(restored).not.toBe(old);
  expect(restored.eventSource.getSnapshot().entries[0]?.event.data).toEqual({ text: "a" });
  expect(restored.getSnapshot().hasMore).toBe(true);
  expect(restored.getSnapshot().openState).toBe("cold");
  const opening = restored.open();
  expect(restored.getSnapshot().openState).toBe("loading");
  const denied = await manager.fork({ sessionId: id });
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error.code).toBe("session/syncing");
  expect(fork).not.toHaveBeenCalled();
  expect(restored.eventSource.getSnapshot().entries[0]?.event.data).toEqual({ text: "a" });
  gate.resolve(undefined);
  await opening;
  expect(restored.getSnapshot().openState).toBe("open");
  expect((await manager.fork({ sessionId: id })).ok).toBe(true);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(restored.eventSource.getSnapshot().entries[0]?.event.data).toEqual({
    text: "authoritative replacement",
  });
  expect(restored.projections.get("codexhostToolOutput")).toEqual({
    command: "authoritative replacement",
  });
  await manager.dispose();
});

it("evicts the least recently used released view after eight and releases its heavy projection values", async () => {
  const { manager } = fixture();
  for (let index = 0; index < 8; index++) {
    const id = SessionId(String(index));
    const session = manager.get(id);
    await session.open();
    await manager.drop(id, session);
  }
  const recent = manager.get(SessionId("0"));
  await recent.open();
  await manager.drop(SessionId("0"), recent);
  const ninth = manager.get(SessionId("8"));
  await ninth.open();
  await manager.drop(SessionId("8"), ninth);
  expect(manager.get(SessionId("0")).eventSource.getSnapshot().entries).toHaveLength(1);
  const evicted = manager.get(SessionId("1"));
  expect(evicted.eventSource.getSnapshot().entries).toHaveLength(0);
  expect(evicted.projections.get("codexhostToolOutput")).toBeUndefined();
  await manager.dispose();
});

it("keeps a durable subagent view when its Agent becomes unavailable", async () => {
  const { manager } = fixture();
  const id = SessionId("child");
  manager.handleSessionAdded({
    sessionId: id,
    parentSessionId: SessionId("parent"),
    origin: "subagent",
    running: false,
    blank: false,
    agentAvailable: true,
    updatedAt: 1,
  });
  const child = manager.get(id);
  await child.open();
  await manager.drop(id, child);
  manager.handleSessionRemoved(id);
  expect(manager.get(id).eventSource.getSnapshot().entries).toHaveLength(1);
  await manager.dispose();
});

it("keeps a first open empty until its snapshot arrives and does not cache a removed Session", async () => {
  const { manager, gates } = fixture();
  const id = SessionId("cold");
  const gate = Promise.withResolvers<undefined>();
  gates.set(id, gate.promise);
  const cold = manager.get(id);
  const opening = cold.open();
  expect(cold.getSnapshot().openState).toBe("loading");
  expect(cold.eventSource.getSnapshot().entries).toHaveLength(0);
  gate.resolve(undefined);
  await opening;
  manager.handleSessionRemoved(id);
  await manager.drop(id, cold);
  expect(manager.get(id).eventSource.getSnapshot().entries).toHaveLength(0);
  await manager.dispose();
});
