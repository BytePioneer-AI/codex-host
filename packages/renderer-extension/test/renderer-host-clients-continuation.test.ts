import { describe, expect, it, vi } from "vitest";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { createRendererHostClients } from "../src/renderer-host-clients.js";

function fixture() {
  let provider = "openai";
  let loaded = true;
  let desktopProvider = "openai";
  const sendRequest = vi.fn(async (method: string, input: unknown) => {
    const params = input as Record<string, unknown>;
    if (method === "thread/read")
      return {
        thread: {
          id: "history-thread",
          modelProvider: provider,
          cliVersion: "0.159.2",
          cwd: "/work",
          status: { type: loaded ? "idle" : "notLoaded" },
        },
      };
    if (method === "config/read")
      return {
        config: {
          model_provider: "custom",
          model_providers: {
            custom: { base_url: "https://relay.example/v1", requires_openai_auth: false },
          },
        },
      };
    if (method === "thread/unsubscribe") {
      loaded = false;
      return { status: "unsubscribed" };
    }
    if (method === "thread/resume") {
      if (!loaded) provider = String(params.modelProvider ?? provider);
      loaded = true;
      return {
        thread: { id: "history-thread", modelProvider: "openai" },
        modelProvider: provider,
        model: "gpt-6.1-sol",
        cwd: "/work",
        approvalPolicy: "never",
        sandbox: { type: "readOnly" },
      };
    }
    if (method === "thread/settings/update") return {};
    throw new Error(`Unexpected ${method}`);
  });
  const resumeThread = vi.fn(async (input: unknown) => {
    const result = await sendRequest("thread/resume", input);
    if (!("thread" in result) || !result.thread) throw new Error("No synthetic resumed Thread");
    desktopProvider = result.thread.modelProvider;
    return result;
  });
  const route = {
    hostId: "local",
    manager: {
      sendRequest,
      resumeThread,
      requestClient: {},
      prewarmedThreadManager: {},
      updateConversationState: (
        _id: string,
        update: (state: { modelProvider?: string }) => void,
      ) => {
        const state = { modelProvider: desktopProvider };
        update(state);
        desktopProvider = state.modelProvider;
      },
    },
    policy: {},
  } as unknown as RendererHostRoute;
  let activeRoute: RendererHostRoute | null = route;
  const routing: RendererHostRouting = {
    forHost: () => activeRoute,
    forComposer: () => activeRoute,
    hostIdForComposer: () => "local",
    dispose() {},
  };
  const clients = createRendererHostClients(() => routing);
  const client = clients.forHost("local");
  if (!client) throw new Error("Synthetic native client unavailable");
  return {
    clients,
    client,
    resumeThread,
    sendRequest,
    desktopProvider: () => desktopProvider,
    retire: () => {
      activeRoute = null;
    },
  };
}

describe("Native continuation follows the Host's Desktop request manager", () => {
  it("adopts resumed Provider metadata through Desktop's native resumeThread contract", async () => {
    const f = fixture();
    await f.client.continueNativeWithConfiguredProvider?.(
      { threadId: hostThreadIdSchema.parse("history-thread") },
      "custom",
    );
    expect(f.desktopProvider()).toBe("custom");
    expect(f.resumeThread).toHaveBeenCalledTimes(2);
    expect(f.sendRequest.mock.calls.some(([method]) => method.startsWith("turn/"))).toBe(false);
    f.clients.dispose();
  });

  it("cannot migrate through a captured manager after the Host route has retired", async () => {
    const f = fixture();
    f.retire();
    await expect(
      f.client.continueNativeWithConfiguredProvider?.(
        { threadId: hostThreadIdSchema.parse("history-thread") },
        "custom",
      ),
    ).rejects.toThrow(/unavailable for Host local/);
    expect(f.resumeThread).not.toHaveBeenCalled();
    expect(f.sendRequest).not.toHaveBeenCalled();
    f.clients.dispose();
  });
});
