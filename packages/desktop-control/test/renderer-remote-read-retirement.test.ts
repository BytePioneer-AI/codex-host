import { expect, it, vi } from "vitest";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";
import { remoteConnectionsExpression } from "../src/remote-connections-control.js";
import type { RemoteSessionTarget } from "../src/renderer-remote-sessions.js";

const hostId = "remote-control:retirement";
const points = ["list", "header", "page", "legacy", "status", "latest", "interactions"] as const;

for (const point of points) {
  it.each(["gone", "replaced", "unchanged"] as const)(
    `classifies a rejected ${point} read when the route is %s`,
    async (retirement) => {
      const original = Object.assign(new Error("cursor anchor is no longer present"), {
        code: -32602,
      });
      const failure = async () => {
        await Promise.resolve();
        if (retirement === "gone") route = null;
        if (retirement === "replaced") route = { manager };
        throw retirement === "unchanged"
          ? original
          : new Error("Remote Control connection retired");
      };
      const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (
          (point === "list" && method === "thread/list") ||
          ((point === "header" || point === "status") && method === "thread/read") ||
          (point === "legacy" && method === "thread/read" && params.includeTurns) ||
          ((point === "page" || point === "latest") && method === "thread/turns/list")
        )
          return failure();
        if (method === "thread/read")
          return {
            thread: {
              id: "thread",
              historyMode: point === "legacy" ? undefined : "paginated",
              status: { type: "active" },
              turns: [],
            },
          };
        if (method === "thread/turns/list") return { data: [], nextCursor: null };
        return {};
      });
      const manager = {
        sendRequest: send,
        getConversation: () => (point === "interactions" ? failure() : { requests: [] }),
      };
      let route: { manager: typeof manager } | null = { manager };
      const target: RemoteSessionTarget = {
        __codexhostHostRoutingV1: {
          knownHostIds: () => [hostId],
          forHost: () => route,
        },
      };
      const operation: RemoteSessionOperation =
        point === "list"
          ? { kind: "list", hostId, cursor: null, archived: false }
          : point === "status" || point === "latest"
            ? { kind: "status", hostId, threadId: "thread" }
            : {
                kind: "read",
                hostId,
                threadId: "thread",
                ...(point === "page" ? { page: { cursor: null, limit: 1 } } : {}),
              };
      const evaluate = new Function(
        "window",
        `return ${remoteConnectionsExpression({ action: "session", operation })}`,
      );
      const result = await evaluate(target);
      expect(result).toMatchObject({
        error: {
          code: retirement === "gone" ? -32090 : retirement === "replaced" ? -32095 : -32602,
        },
      });
      if (retirement === "unchanged") expect(result.error.message).toBe(original.message);
      expect(send.mock.calls.filter(([method]) => method.startsWith("turn/"))).toHaveLength(0);
    },
  );
}

it("rejects a successful catalog response from a replaced route", async () => {
  const manager = {
    async sendRequest() {
      route = { manager };
      return { data: [], nextCursor: null };
    },
  };
  let route = { manager };
  const target: RemoteSessionTarget = {
    __codexhostHostRoutingV1: { knownHostIds: () => [hostId], forHost: () => route },
  };
  const evaluate = new Function(
    "window",
    `return ${remoteConnectionsExpression({
      action: "session",
      operation: { kind: "list", hostId, cursor: null, archived: false },
    })}`,
  );
  expect(await evaluate(target)).toMatchObject({ error: { code: -32095 } });
});
