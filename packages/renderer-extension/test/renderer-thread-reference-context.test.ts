import { expect, it, vi } from "vitest";
import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { createRendererHostClients } from "../src/renderer-host-clients.js";

function fixture(hostId: string, provider = "codexhost") {
  const rpc = vi.fn(async (method: unknown, params: unknown) => {
    void method;
    void params;
    return {};
  });
  const manager = {
    sendRequest: rpc,
    getConversation: (id: string) => ({ id, modelProvider: provider }),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    getTurnCoordinator: () => ({}),
  };
  const route = { hostId, manager, policy: {} } as unknown as RendererHostRoute;
  let current: RendererHostRoute | null = route;
  const routing = { forHost: () => current } as unknown as RendererHostRouting;
  const clients = createRendererHostClients(() => routing);
  clients.forHost(hostId);
  return {
    manager,
    rpc,
    retire: () => {
      current = null;
    },
    dispose: () => clients.dispose(),
  };
}

it.each(["turn/start", "turn/steer"])(
  "scopes %s to its actual remote Manager without changing user text",
  async (method) => {
    const first = fixture("remote-ssh-discovered:mac");
    const second = fixture("other-host");
    const params = {
      threadId: "thread",
      input: [{ type: "text", text: "thread://target?hostId=remote-ssh-discovered%3Amac" }],
    };
    try {
      await first.manager.sendRequest(method, params);
      await second.manager.sendRequest(method, params);
      expect(first.rpc).toHaveBeenCalledWith(
        method,
        { ...params, codexhostSourceHostId: "remote-ssh-discovered:mac" },
        undefined,
      );
      expect(second.rpc).toHaveBeenCalledWith(
        method,
        { ...params, codexhostSourceHostId: "other-host" },
        undefined,
      );
      expect(params).not.toHaveProperty("codexhostSourceHostId");
      first.retire();
      expect(() => first.manager.sendRequest(method, params)).toThrow(
        "connection is no longer available",
      );
    } finally {
      first.dispose();
      second.dispose();
    }
  },
);

it.each([
  ["local", "codexhost"],
  ["remote", "openai"],
])("preserves %s/%s submissions", async (hostId, provider) => {
  const f = fixture(hostId, provider);
  const params = { threadId: "thread", input: [] };
  try {
    await f.manager.sendRequest("turn/start", params);
    expect(f.rpc.mock.calls[0]?.[1]).toBe(params);
  } finally {
    f.dispose();
  }
});
