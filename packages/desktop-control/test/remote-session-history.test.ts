import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RemoteConnectionsRequest, RemoteConnectionsReply } from "@codexhost/shared-contracts";
import { startControllerAttachmentServer } from "../src/controller-attachment-server.js";
import { remoteConnectionsExpression } from "../src/remote-connections-control.js";
import { requestRemoteSession, RemoteSessionError } from "../src/remote-session-client.js";
import type { RemoteSessionTarget } from "../src/renderer-remote-sessions.js";

const hostId = "remote-ssh-discovered:fixture";

async function withController(
  handler: (request: RemoteConnectionsRequest) => Promise<RemoteConnectionsReply>,
  check: (descriptor: string) => Promise<void>,
  rejectAtWire = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "remote-history-"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const nonce = "1".repeat(32);
  const rejectedServer = rejectAtWire
    ? createServer((socket) => socket.once("data", () => socket.end("rejected\n")))
    : undefined;
  if (rejectedServer)
    await new Promise<void>((resolve) => rejectedServer.listen(address.port, "127.0.0.1", resolve));
  const controller = rejectedServer
    ? { close: () => new Promise<void>((resolve) => rejectedServer.close(() => resolve())) }
    : await startControllerAttachmentServer({
        port: address.port,
        nonce,
        attach: async () => undefined,
        remoteConnections: handler,
      });
  try {
    const descriptor = join(directory, "desktop-runtime-v1.json");
    await writeFile(
      descriptor,
      JSON.stringify({
        schema_version: 1,
        launcher_pid: process.pid,
        control_port: address.port,
        nonce,
      }),
      { mode: 0o600 },
    );
    await check(descriptor);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function rendererFixture(turns: Array<{ id: string; items: unknown[] }>) {
  const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/read") {
      if (params.includeTurns) throw new Error("Paginated history cannot use full thread/read");
      return { thread: { id: "native", historyMode: "paginated", cwd: "/remote" } };
    }
    if (method === "thread/turns/list") {
      const start = params.cursor === null ? 0 : Number(params.cursor);
      const ordered = params.sortDirection === "desc" ? turns.toReversed() : turns;
      const data = ordered.slice(start, start + Number(params.limit));
      return {
        data,
        nextCursor: start + data.length < turns.length ? String(start + data.length) : null,
      };
    }
    return {};
  });
  const route = { manager: { sendRequest: send } };
  const target: RemoteSessionTarget = {
    __codexhostHostRoutingV1: { knownHostIds: () => [hostId], forHost: () => route },
  };
  const requests: RemoteConnectionsRequest[] = [];
  return {
    send,
    target,
    requests,
    handler: async (request: RemoteConnectionsRequest): Promise<RemoteConnectionsReply> => {
      requests.push(request);
      return new Function("window", `return ${remoteConnectionsExpression(request)}`)(target);
    },
  };
}

it("requests a bounded newest-first page for a live refresh", async () => {
  const fixture = rendererFixture(["old", "latest"].map((id) => ({ id, items: [] })));
  await withController(fixture.handler, async (descriptor) => {
    const snapshot = (await requestRemoteSession(
      {
        kind: "read",
        hostId,
        threadId: "native",
        page: { cursor: null, sortDirection: "desc", limit: 1 },
      },
      descriptor,
    )) as {
      result: { thread: { turns: Array<{ id: string }> } };
      nextCursor: string;
    };
    expect(snapshot.result.thread.turns.map((turn) => turn.id)).toEqual(["latest"]);
    expect(snapshot.nextCursor).toBe("1");
    expect(fixture.send).toHaveBeenCalledWith("thread/turns/list", {
      threadId: "native",
      cursor: null,
      sortDirection: "desc",
      limit: 1,
      itemsView: "full",
    });
  });
});

it("keeps a missing remote route classified as a connection failure", async () => {
  const fixture = rendererFixture([]);
  const routing = fixture.target.__codexhostHostRoutingV1;
  if (!routing) throw new Error("Missing fixture routing");
  routing.forHost = () => null;
  await withController(fixture.handler, async (descriptor) => {
    await expect(
      requestRemoteSession({ kind: "read", hostId, threadId: "native" }, descriptor),
    ).rejects.toMatchObject({ code: -32090, message: "Remote Host is offline" });
    expect(fixture.send).not.toHaveBeenCalled();
  });
});

it("loads complete history larger than one Controller reply through authenticated pages", async () => {
  const text = "x".repeat(6 * 1024 * 1024);
  const turns = ["one", "two", "three"].map((id) => ({ id, items: [{ id, text }] }));
  const fixture = rendererFixture(turns);
  await withController(fixture.handler, async (descriptor) => {
    const snapshot = (await requestRemoteSession(
      { kind: "read", hostId, threadId: "native" },
      descriptor,
    )) as { result: { thread: { turns: typeof turns } }; epoch: string; nextCursor?: unknown };
    expect(snapshot.result.thread.turns).toEqual(turns);
    expect(snapshot.nextCursor).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toMatchObject({
      action: "session",
      operation: { page: { cursor: "1", epoch: snapshot.epoch } },
    });
    expect(fixture.send).toHaveBeenCalledWith(
      "thread/turns/list",
      expect.objectContaining({ cursor: null, limit: 1 }),
    );
  });
}, 20_000);

it("reports a single oversized Turn with its error code and no partial history", async () => {
  const fixture = rendererFixture([{ id: "one", items: [{ text: "x".repeat(15 * 1024 * 1024) }] }]);
  await withController(fixture.handler, async (descriptor) => {
    await expect(
      requestRemoteSession({ kind: "read", hostId, threadId: "native" }, descriptor),
    ).rejects.toMatchObject({
      code: -32094,
      message: expect.stringContaining("A remote Turn exceeds"),
    });
    expect(fixture.requests).toHaveLength(1);
  });
});

it.each(["changed-epoch", "repeated-cursor", "missing-page"])(
  "rejects %s instead of returning partial history",
  async (failure) => {
    let calls = 0;
    await withController(
      async () => {
        calls++;
        return {
          result: {
            result: { thread: { id: "native", turns: [{ id: String(calls), items: [] }] } },
            epoch: failure === "changed-epoch" && calls > 1 ? "new" : "original",
            requests: [],
            ...(failure === "missing-page" ? {} : { nextCursor: "next" }),
          },
        };
      },
      async (descriptor) => {
        await expect(
          requestRemoteSession({ kind: "read", hostId, threadId: "native" }, descriptor),
        ).rejects.toBeInstanceOf(RemoteSessionError);
        expect(calls).toBe(failure === "missing-page" ? 1 : 2);
      },
    );
  },
);

it("reports an older Controller's wire rejection without guessing its cause or retrying", async () => {
  let calls = 0;
  await withController(
    async () => {
      calls++;
      return { error: { code: -32602, message: "Invalid remote connection request" } };
    },
    async (descriptor) => {
      await expect(
        requestRemoteSession({ kind: "read", hostId, threadId: "native" }, descriptor),
      ).rejects.toMatchObject({
        code: -32096,
        message: expect.stringContaining("Controller rejected"),
      });
      expect(calls).toBe(0);
    },
    true,
  );
});

it("preserves an expired native cursor error instead of misdiagnosing an older Controller", async () => {
  let calls = 0;
  await withController(
    async () => {
      if (++calls === 1)
        return {
          result: {
            result: { thread: { id: "native", turns: [{ id: "one", items: [] }] } },
            epoch: "one",
            nextCursor: "next",
          },
        };
      return { error: { code: -32602, message: "cursor anchor is no longer present" } };
    },
    async (descriptor) => {
      await expect(
        requestRemoteSession({ kind: "read", hostId, threadId: "native" }, descriptor),
      ).rejects.toMatchObject({ code: -32602, message: "cursor anchor is no longer present" });
      expect(calls).toBe(2);
    },
  );
});
