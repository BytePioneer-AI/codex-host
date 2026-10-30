import { runInNewContext } from "node:vm";
import {
  decodeHarnessPluginRoute,
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
} from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import { installRendererDraftPrewarmPolicyDirect } from "../src/renderer-draft-prewarm-policy.js";
import type { RendererHostRouting as Routing } from "../src/renderer-host-routing.js";

const carrier = encodeHarnessPluginRoute(
  harnessPluginRouteSchema.parse({
    harnessId: "claude-code",
    model: { id: "claude-model-v1.c29ubmV0" },
    thinkingOptionId: "auto",
  }),
);

/** Desktop 26.1027: managers live in the main process; the Renderer keeps one
 * capnweb stub per Host in a signal family of the app scope store. */
function setup(
  options: { connectionFamilies?: number; nativeManager?: boolean; hosts?: string[] } = {},
) {
  const rpc = {
    sendRequest: vi.fn(async () => ({ entries: [] })),
    clearPrewarmedThreads: vi.fn(async () => undefined),
  };
  const connections = new Map(
    (options.hosts ?? ["local"]).map((hostId) => [
      hostId,
      { status: "ready", client: { hostId, rpc: { ...rpc } } },
    ]),
  );
  const signal = (value: unknown) => ({ value: { get: () => value, set: vi.fn() } });
  const familyBindings = new Map<unknown, Map<unknown, unknown>>([
    // Account clients share the Host key but not the connection value shape.
    [{ kind: "signal-family" }, new Map([["local", signal({ hostId: "local", rpc: {} })]])],
  ]);
  for (let index = 0; index < (options.connectionFamilies ?? 1); index += 1) {
    familyBindings.set(
      { kind: "signal-family" },
      new Map([...connections].map(([hostId, connection]) => [hostId, signal(connection)])),
    );
  }
  const store = { familyBindings, parent: undefined };
  const handle = {
    chain: {},
    node: { parent: store },
    scope: {},
    get: vi.fn(),
    set: vi.fn(),
    watch: vi.fn(),
  };
  const rootFiber = {
    memoizedState: { memoizedState: { current: handle }, next: null },
    child: null,
    sibling: null,
  };
  const container = { __reactContainer$app: rootFiber };
  const composerFiber = {
    memoizedProps: { executionTargetHostId: "local" },
    memoizedState: options.nativeManager
      ? {
          memoizedState: {
            getHostId: () => "local",
            sendRequest: vi.fn(),
            requestClient: {
              sendRequest: vi.fn(),
              prewarmThreadStart: vi.fn(),
              enqueueRequest: vi.fn(),
            },
            prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
          },
          next: null,
        }
      : null,
    return: null,
  };
  const editors = [{ __reactFiber$app: composerFiber, parentElement: null }];
  const sent: unknown[] = [];
  class MessagePort {
    postMessage(message: unknown): void {
      sent.push(message);
    }
  }
  const target: Record<string, unknown> = {};
  const renderer = {
    async evaluate<T>(expression: string): Promise<T> {
      return await runInNewContext(expression, {
        document: {
          querySelectorAll: () => editors,
          getElementById: (id: string) => (id === "root" ? container : null),
        },
        window: target,
        MessagePort,
        crypto: globalThis.crypto,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        setTimeout,
        clearTimeout,
      });
    },
  };
  const post = (message: unknown) =>
    (MessagePort.prototype as { postMessage(message: unknown): void }).postMessage.call(
      new MessagePort(),
      message,
    );
  return { renderer, target, rpc, connections, sent, post, MessagePort };
}

function policyOf(route: ReturnType<Routing["forHost"]>) {
  if (!route) throw new Error("Host route is unavailable");
  return route.policy;
}

async function install(fixture: ReturnType<typeof setup>): Promise<Routing> {
  await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
  return fixture.target.__codexhostHostRoutingV1 as Routing;
}

function creation(method: string, model: string, options: Record<string, unknown>) {
  return [
    "push",
    [
      "pipeline",
      -188,
      [method],
      [
        {
          input: [[{ type: "text", text: "hello" }]],
          collaborationMode: { mode: "default", settings: { model, reasoning_effort: "high" } },
          cwd: "/work",
        },
        options,
      ],
    ],
  ];
}

it("routes Host requests through the main-process RPC client without native internals", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const route = routing.forComposer();
    expect(route?.manager).toMatchObject({ kind: "main-process-rpc" });
    expect(route?.manager).not.toHaveProperty("requestClient");
    expect(routing.knownHostIds?.()).toEqual(["local"]);
    await route?.manager.sendRequest("codexhost/harness/display-settings/get", {});
    expect(fixture.rpc.sendRequest).toHaveBeenCalledWith(
      "codexhost/harness/display-settings/get",
      {},
    );
  } finally {
    routing.dispose();
  }
});

it("applies an external draft's carrier only to that draft's creation call", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const policy = policyOf(routing.forComposer());
    expect(policy.select(carrier, "client-new-thread:external")).toBe(true);
    expect(fixture.rpc.clearPrewarmedThreads).toHaveBeenCalledTimes(1);
    const exported = ["export", -1320];
    fixture.post(
      creation("startConversation", "gpt-6.1-sol", {
        clientThreadId: "client-new-thread:external",
        onSettled: exported,
      }),
    );
    fixture.post(
      creation("startConversation", "gpt-6.1-sol", { clientThreadId: "client-new-thread:codex" }),
    );
    fixture.post(["push", ["pipeline", -188, ["sendRequest"], ["model/list", {}]]]);
    const [external, codex, request] = fixture.sent as [unknown[], unknown, unknown];
    const args = (external[1] as unknown[])[3] as Record<string, unknown>[];
    expect(args[0]?.collaborationMode).toEqual({
      mode: "default",
      settings: { model: carrier, reasoning_effort: "high" },
    });
    expect(args[1]).toEqual({ clientThreadId: "client-new-thread:external", onSettled: exported });
    expect(codex).toEqual(
      creation("startConversation", "gpt-6.1-sol", { clientThreadId: "client-new-thread:codex" }),
    );
    expect(request).toEqual(["push", ["pipeline", -188, ["sendRequest"], ["model/list", {}]]]);
  } finally {
    routing.dispose();
  }
});

it.each(["disconnected", "replaced"])(
  "clears only the retired Host's drafts when its RPC is %s",
  async (change) => {
    const fixture = setup({ hosts: ["local", "remote"] });
    const routing = await install(fixture);
    try {
      const oldPolicy = policyOf(routing.forHost("local"));
      oldPolicy.select(carrier, "client-new-thread:local");
      policyOf(routing.forHost("remote")).select(carrier, "client-new-thread:remote");
      const connection = fixture.connections.get("local");
      if (!connection) throw new Error("Missing local fixture connection");
      if (change === "disconnected") connection.status = "disconnected";
      else connection.client.rpc = { ...fixture.rpc };
      const replacement = routing.forHost("local");
      expect(replacement === null).toBe(change === "disconnected");
      const local = creation("startConversation", "official", {
        clientThreadId: "client-new-thread:local",
      });
      fixture.post(local);
      expect(fixture.sent.at(-1)).toEqual(local);
      fixture.post(
        creation("startConversation", "official", { clientThreadId: "client-new-thread:remote" }),
      );
      expect(fixture.sent.at(-1)).toEqual(
        creation("startConversation", carrier, { clientThreadId: "client-new-thread:remote" }),
      );
      connection.status = "ready";
      const next = policyOf(routing.forHost("local"));
      next.select(carrier, "client-new-thread:local");
      oldPolicy.dispose();
      fixture.post(local);
      expect(fixture.sent.at(-1)).toEqual(
        creation("startConversation", carrier, { clientThreadId: "client-new-thread:local" }),
      );
      next.select(null);
      fixture.post(local);
      expect(fixture.sent.at(-1)).toEqual(local);
      fixture.post(
        creation("startConversation", "official", { clientThreadId: "client-new-thread:remote" }),
      );
      expect(fixture.sent.at(-1)).toEqual(
        creation("startConversation", carrier, { clientThreadId: "client-new-thread:remote" }),
      );
    } finally {
      routing.dispose();
    }
  },
);

it("marks local prewarms with the selected carrier and stops after the draft returns to Codex", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const policy = policyOf(routing.forHost("local"));
    policy.select(carrier, "client-new-thread:external");
    fixture.post(creation("prewarmConversation", "gpt-6.1-sol", {}));
    const prewarmed = (((fixture.sent[0] as unknown[])[1] as unknown[])[3] as unknown[])[0] as {
      collaborationMode: { settings: { model: string } };
    };
    expect(decodeHarnessPluginRoute(prewarmed.collaborationMode.settings.model)).toEqual({
      ...decodeHarnessPluginRoute(carrier),
      prewarm: true,
    });

    expect(policy.select(null, "client-new-thread:external")).toBe(true);
    expect(fixture.rpc.clearPrewarmedThreads).toHaveBeenCalledTimes(2);
    fixture.post(creation("prewarmConversation", "gpt-6.1-sol", {}));
    expect(fixture.sent[1]).toEqual(creation("prewarmConversation", "gpt-6.1-sol", {}));
  } finally {
    routing.dispose();
  }
});

it("publishes the local draft workspace named by its prewarm", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    fixture.post(creation("prewarmConversation", "gpt-6.1-sol", {}));
    expect(fixture.target.__codexhostDraftWorkspacesV1).toEqual({ local: "/work" });
  } finally {
    routing.dispose();
  }
});

it("restores the native port when routing is disposed", async () => {
  const fixture = setup();
  const original = (fixture.MessagePort.prototype as { postMessage: unknown }).postMessage;
  const routing = await install(fixture);
  expect((fixture.MessagePort.prototype as { postMessage: unknown }).postMessage).not.toBe(
    original,
  );
  routing.dispose();
  expect((fixture.MessagePort.prototype as { postMessage: unknown }).postMessage).toBe(original);
});

it("stays unavailable when Host connection values are ambiguous", async () => {
  const fixture = setup({ connectionFamilies: 2 });
  vi.useFakeTimers();
  try {
    const pending = installRendererDraftPrewarmPolicyDirect(fixture.renderer);
    const failure = expect(pending).rejects.toThrow("Renderer Host request manager is unavailable");
    await vi.advanceTimersByTimeAsync(61_000);
    await failure;
    expect(fixture.target.__codexhostHostRoutingV1).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the native manager path when Desktop exposes one in the Renderer", async () => {
  const fixture = setup({ nativeManager: true });
  const original = (fixture.MessagePort.prototype as { postMessage: unknown }).postMessage;
  const routing = await install(fixture);
  try {
    expect(routing.forComposer()?.manager).toHaveProperty("requestClient");
    expect((fixture.MessagePort.prototype as { postMessage: unknown }).postMessage).toBe(original);
  } finally {
    routing.dispose();
  }
});
