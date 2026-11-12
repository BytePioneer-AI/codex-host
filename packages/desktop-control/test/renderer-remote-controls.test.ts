import { expect, it, vi } from "vitest";
import { remoteConnectionsExpression } from "../src/remote-connections-control.js";
import { remoteSessionOperationSchema } from "@codexhost/shared-contracts";
import {
  rendererRemoteSession,
  type RemoteSessionTarget,
} from "../src/renderer-remote-sessions.js";

function fixture() {
  const owner = {
    owner: "external",
    harnessId: "claude-code",
    effectiveModel: { id: "fable" },
    effectivePermissionModeId: "default",
  };
  const send = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "thread/read") {
      if (params.includeTurns) throw Error("Paginated External Threads require thread/turns/list");
      return {
        thread: {
          id: "same",
          modelProvider: "codexhost",
          historyMode: "paginated",
          cwd: "/remote",
        },
      };
    }
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: params.cursor ? "second" : "first",
            itemsView: "full",
            items: [{ text: "history" }],
          },
        ],
        nextCursor: params.cursor ? null : "next",
      };
    if (method === "codexhost/thread/inspect") return owner;
    if (method === "codexhost/harness/inspect")
      return { status: "ready", models: { models: [{ id: "fable" }] } };
    if (method === "codexhost/harness/plugins/list")
      return { plugins: [{ id: "claude-code", name: "Claude Code" }] };
    return {};
  });
  const route = { manager: { sendRequest: send } };
  const routes = new Map([
    ["remote-ssh-discovered:mac", route],
    ["remote-control:other", { manager: { sendRequest: vi.fn() } }],
  ]);
  const target: RemoteSessionTarget = {
    __codexhostHostRoutingV1: {
      knownHostIds: () => [...routes.keys()],
      forHost: (id) => routes.get(id) ?? null,
    },
  };
  const read = () =>
    rendererRemoteSession(target, {
      kind: "read",
      hostId: "remote-ssh-discovered:mac",
      threadId: "same",
    }) as Promise<{
      result: { thread: { turns: Array<{ id: string }> } };
      epoch: string;
      configuration?: typeof owner;
      harness?: { name: string };
    }>;
  return { send, read, routes, target, route };
}
it("reads full paginated history and remote identity without using the legacy full read", async () => {
  const f = fixture();
  const r = await f.read();
  expect(r.result.thread.turns.map((t) => t.id)).toEqual(["first", "second"]);
  expect(r.configuration?.harnessId).toBe("claude-code");
  expect(r.harness?.name).toBe("Claude Code");
  expect(f.send).toHaveBeenCalledWith(
    "thread/turns/list",
    expect.objectContaining({ itemsView: "full", cursor: "next", sortDirection: "asc" }),
  );
  await f.read();
  expect(f.send.mock.calls.filter(([m]) => m === "codexhost/harness/inspect")).toHaveLength(1);
});
it("rejects repeated cursors instead of returning partial history", async () => {
  const f = fixture();
  f.send.mockImplementation(async (method) =>
    method === "thread/read"
      ? { thread: { historyMode: "paginated" } }
      : { data: [], nextCursor: "repeat" },
  );
  await expect(f.read()).rejects.toThrow("cursor repeated");
});
it("keeps history available when optional inspection fails without polling unavailable Harnesses", async () => {
  const f = fixture();
  const original = f.send.getMockImplementation();
  if (!original) throw new Error("Missing mock implementation");
  f.send.mockImplementation((method, params) => {
    if (method === "codexhost/harness/inspect") throw Error("unavailable");
    return original(method, params);
  });
  expect((await f.read()).result.thread.turns).toHaveLength(2);
  expect((await f.read()).result.thread.turns).toHaveLength(2);
  expect(f.send.mock.calls.filter(([m]) => m === "codexhost/harness/inspect")).toHaveLength(1);
});
it.each(["rejected", "unavailable"])(
  "retries %s discovery with capped backoff and keeps successful discovery cached",
  async (failure) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const f = fixture();
      const original = f.send.getMockImplementation();
      if (!original) throw new Error("Missing mock implementation");
      let available = false;
      f.send.mockImplementation((method, params) => {
        if (method === "codexhost/harness/inspect" && !available) {
          if (failure === "rejected") throw Error("temporarily unavailable");
          return Promise.resolve({ status: "unavailable" });
        }
        return original(method, params);
      });
      let attempts = 0;
      for (const time of [0, 5_000, 15_000, 35_000, 65_000, 95_000]) {
        now.mockReturnValue(time);
        expect((await f.read()).result.thread.turns).toHaveLength(2);
        attempts++;
        now.mockReturnValue(time + 1_500);
        await f.read();
        expect(f.send.mock.calls.filter(([m]) => m === "codexhost/harness/inspect")).toHaveLength(
          attempts,
        );
      }
      available = true;
      now.mockReturnValue(125_000);
      expect((await f.read()).harness?.name).toBe("Claude Code");
      now.mockReturnValue(1_000_000);
      await f.read();
      expect(f.send.mock.calls.filter(([m]) => m === "codexhost/harness/inspect")).toHaveLength(7);
    } finally {
      now.mockRestore();
    }
  },
);
it("does not share discovery backoff or configuration epochs with a replacement route", async () => {
  const f = fixture();
  const original = f.send.getMockImplementation();
  if (!original) throw new Error("Missing mock implementation");
  let unavailable = true;
  f.send.mockImplementation((method, params) => {
    if (method === "codexhost/harness/inspect" && unavailable) throw Error("unavailable");
    return original(method, params);
  });
  const old = await f.read();
  unavailable = false;
  f.routes.set("remote-ssh-discovered:mac", { manager: f.route.manager });
  const current = await f.read();
  expect(current.harness?.name).toBe("Claude Code");
  expect(current.epoch).not.toBe(old.epoch);
  await expect(
    rendererRemoteSession(f.target, {
      kind: "configure",
      hostId: "remote-ssh-discovered:mac",
      threadId: "same",
      epoch: old.epoch,
      modelId: "another",
    }),
  ).rejects.toThrow("changed");
  expect(f.send.mock.calls.filter(([m]) => m === "codexhost/harness/inspect")).toHaveLength(2);
  expect(f.send.mock.calls.some(([m]) => m === "codexhost/thread/model/select")).toBe(false);
});
it("rejects a route replaced while awaiting a native configuration reply without replay", async () => {
  const f = fixture();
  const r = await f.read();
  const original = f.send.getMockImplementation();
  if (!original) throw new Error("Missing mock implementation");
  f.send.mockImplementation((method, params) => {
    if (method === "codexhost/thread/model/select") {
      f.routes.set("remote-ssh-discovered:mac", { manager: { sendRequest: vi.fn() } });
      return Promise.resolve({ effectiveModel: { id: "another" } });
    }
    return original(method, params);
  });
  await expect(
    rendererRemoteSession(f.target, {
      kind: "configure",
      hostId: "remote-ssh-discovered:mac",
      threadId: "same",
      epoch: r.epoch,
      modelId: "another",
    }),
  ).rejects.toThrow("changed");
  expect(f.send.mock.calls.filter(([m]) => m === "codexhost/thread/model/select")).toHaveLength(1);
});
it("selects only the scoped remote model, invalidates discovery and never replays lost writes", async () => {
  const f = fixture();
  const r = await f.read();
  const original = f.send.getMockImplementation();
  if (!original) throw new Error("Missing mock implementation");
  f.send.mockImplementation(async (method, params) => {
    if (method === "codexhost/thread/model/select") throw Error("lost reply");
    return original(method, params);
  });
  await expect(
    rendererRemoteSession(f.target, {
      kind: "configure",
      hostId: "remote-ssh-discovered:mac",
      threadId: "same",
      epoch: r.epoch,
      modelId: "another",
    }),
  ).rejects.toThrow("lost reply");
  expect(f.send).toHaveBeenCalledWith("codexhost/thread/model/select", {
    threadId: "same",
    model: { id: "another" },
  });
  expect(f.send.mock.calls.filter(([m]) => m === "codexhost/thread/model/select")).toHaveLength(1);
  expect(f.routes.get("remote-control:other")?.manager.sendRequest).not.toHaveBeenCalled();
  await f.read();
  expect(f.send.mock.calls.filter(([m]) => m === "codexhost/harness/inspect")).toHaveLength(2);
});
it("rejects a route replaced during discovery before sending a configuration mutation", async () => {
  const f = fixture();
  const r = await f.read();
  f.send.mockImplementation(async () => {
    f.routes.set("remote-ssh-discovered:mac", { manager: { sendRequest: vi.fn() } });
    return { owner: "external" };
  });
  await expect(
    rendererRemoteSession(f.target, {
      kind: "configure",
      hostId: "remote-ssh-discovered:mac",
      threadId: "same",
      epoch: r.epoch,
      permissionModeId: "default",
    }),
  ).rejects.toThrow("changed");
  expect(f.send.mock.calls.some(([m]) => m === "codexhost/thread/permission-mode/select")).toBe(
    false,
  );
});
it("permits exactly one bounded setting per operation", () => {
  const op = {
    kind: "configure",
    hostId: "remote-ssh-discovered:mac",
    threadId: "same",
    epoch: "epoch",
  };
  expect(remoteSessionOperationSchema.safeParse(op).success).toBe(false);
  expect(
    remoteSessionOperationSchema.safeParse({ ...op, modelId: "a", permissionModeId: "default" })
      .success,
  ).toBe(false);
  expect(remoteSessionOperationSchema.safeParse({ ...op, modelId: "a" }).success).toBe(true);
  expect(
    remoteSessionOperationSchema.safeParse({ ...op, thinkingOptionId: "medium" }).success,
  ).toBe(true);
});

it("runs the paginated read and settings write through the serialized Controller expression", async () => {
  const f = fixture();
  const evaluate = async (operation: unknown) =>
    new Function(
      "window",
      `return ${remoteConnectionsExpression({ action: "session", operation } as Parameters<typeof remoteConnectionsExpression>[0])}`,
    )(f.target);
  const read = await evaluate({
    kind: "read",
    hostId: "remote-ssh-discovered:mac",
    threadId: "same",
  });
  expect(read.error).toBeUndefined();
  expect(read.result.result.thread.turns).toHaveLength(2);
  const selected = await evaluate({
    kind: "configure",
    hostId: "remote-ssh-discovered:mac",
    threadId: "same",
    epoch: read.result.epoch,
    thinkingOptionId: "medium",
  });
  expect(selected.error).toBeUndefined();
  expect(f.send).toHaveBeenCalledWith("codexhost/thread/thinking/select", {
    threadId: "same",
    thinkingOptionId: "medium",
  });
});

it("rejects oversized or malformed pages without exposing a truncated snapshot", async () => {
  const f = fixture();
  const original = f.send.getMockImplementation();
  if (!original) throw new Error("Missing mock implementation");
  f.send.mockImplementation(async (method, params) =>
    method === "thread/turns/list" ? { data: [], nextCursor: 1 } : original(method, params),
  );
  await expect(f.read()).rejects.toThrow("Invalid remote history page");
  f.send.mockImplementation(async (method, params) =>
    method === "thread/turns/list"
      ? { data: [{ text: "x".repeat(14 * 1024 * 1024) }], nextCursor: null }
      : original(method, params),
  );
  await expect(f.read()).rejects.toThrow("snapshot limit");
});
it("checks route identity after the final page before returning history", async () => {
  const f = fixture();
  const original = f.send.getMockImplementation();
  if (!original) throw new Error("Missing mock implementation");
  f.send.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/turns/list" && params.cursor)
      f.routes.set("remote-ssh-discovered:mac", { manager: { sendRequest: vi.fn() } });
    return result;
  });
  await expect(f.read()).rejects.toThrow("changed");
  expect(f.send.mock.calls.some(([method]) => method === "codexhost/thread/inspect")).toBe(false);
});

it("does not dispatch legacy history or metadata after a header read replaces the route", async () => {
  const f = fixture();
  f.send.mockImplementation(async () => {
    f.routes.set("remote-ssh-discovered:mac", { manager: { sendRequest: vi.fn() } });
    return { thread: { historyMode: "legacy", modelProvider: "codexhost" } };
  });
  await expect(f.read()).rejects.toThrow("changed");
  expect(f.send.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
});
it("does not discover Harnesses after ownership inspection replaces the route", async () => {
  const f = fixture();
  const original = f.send.getMockImplementation();
  if (!original) throw new Error("Missing mock implementation");
  f.send.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === "codexhost/thread/inspect")
      f.routes.set("remote-ssh-discovered:mac", { manager: { sendRequest: vi.fn() } });
    return result;
  });
  await expect(f.read()).rejects.toThrow("changed");
  expect(f.send.mock.calls.some(([method]) => method === "codexhost/harness/inspect")).toBe(false);
});
