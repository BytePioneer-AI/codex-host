import { describe, expect, it, vi } from "vitest";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { createRendererHostClients } from "../src/renderer-host-clients.js";

function fixture(inheritedResume = false) {
  let provider = "openai";
  let loaded = true;
  let desktopProvider = "openai";
  const desktopModel = {
    latestModel: "historical-model",
    latestCollaborationMode: {
      mode: "plan",
      settings: { model: "historical-model", reasoning_effort: "high" },
    },
    latestThreadSettings: { model: "historical-model", approvalPolicy: "never" },
  };
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
    if (method === "thread/loaded/list") return { data: loaded ? ["history-thread"] : [] };
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
        update: (state: { modelProvider?: string } & typeof desktopModel) => void,
      ) => {
        const state = { modelProvider: desktopProvider, ...desktopModel };
        update(state);
        desktopProvider = state.modelProvider;
        Object.assign(desktopModel, state);
      },
    },
    policy: {},
  } as unknown as RendererHostRoute;
  const managerPrototype = { resumeThread };
  if (inheritedResume) {
    Reflect.deleteProperty(route.manager, "resumeThread");
    Object.setPrototypeOf(route.manager, managerPrototype);
  }
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
    manager: route.manager,
    managerPrototype,
    resumeThread,
    sendRequest,
    desktopProvider: () => desktopProvider,
    desktopModel,
    retire: () => {
      activeRoute = null;
    },
  };
}

describe("Native continuation follows the Host's Desktop request manager", () => {
  it("adopts effective models for native Sidebar resumes outside the extension client", async () => {
    const f = fixture();
    await f.manager.resumeThread?.({ threadId: "history-thread" });
    expect(f.desktopModel.latestModel).toBe("gpt-6.1-sol");
    expect(f.desktopModel.latestCollaborationMode.settings.model).toBe("gpt-6.1-sol");
    expect(f.desktopModel.latestThreadSettings.model).toBe("gpt-6.1-sol");
    f.clients.dispose();
    expect(f.manager.resumeThread).toBe(f.resumeThread);
  });

  it("keeps native RpcTarget methods inherited and restores the original prototype", async () => {
    const f = fixture(true);
    expect(Object.hasOwn(f.manager, "resumeThread")).toBe(false);
    expect(f.managerPrototype.resumeThread).toBe(f.resumeThread);
    await f.manager.resumeThread?.({ threadId: "history-thread" });
    expect(f.desktopModel.latestModel).toBe("gpt-6.1-sol");
    f.clients.dispose();
    expect(Object.getPrototypeOf(f.manager)).toBe(f.managerPrototype);
  });

  it.each(["retired", "disposed"])(
    "ignores a native resume response after its Host is %s",
    async (state) => {
      const f = fixture();
      const result = await f.resumeThread({ threadId: "history-thread" });
      let finish: (value: typeof result) => void = () => {
        throw new Error("Synthetic resume was not started");
      };
      f.resumeThread.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = f.manager.resumeThread?.({ threadId: "history-thread" });
      if (state === "retired") f.retire();
      else f.clients.dispose();
      finish(result);
      await pending;
      expect(f.desktopModel.latestModel).toBe("historical-model");
      f.clients.dispose();
    },
  );

  it.each(["external", "mismatched"])("does not adopt %s native resume metadata", async (kind) => {
    const f = fixture();
    const response = {
      thread: {
        id: kind === "mismatched" ? "other-thread" : "history-thread",
        modelProvider: "openai",
      },
      modelProvider: kind === "external" ? "codexhost" : "custom",
      model: "gpt-6.1-sol",
      cwd: "/work",
      approvalPolicy: "never",
      sandbox: { type: "readOnly" },
    };
    f.resumeThread.mockResolvedValueOnce(response);
    expect(await f.manager.resumeThread?.({ threadId: "history-thread" })).toBe(response);
    expect(f.desktopModel.latestModel).toBe("historical-model");
    f.clients.dispose();
  });

  it("adopts resumed Provider metadata through Desktop's native resumeThread contract", async () => {
    const f = fixture();
    await f.client.continueNativeWithConfiguredProvider?.(
      { threadId: hostThreadIdSchema.parse("history-thread") },
      "custom",
    );
    expect(f.desktopProvider()).toBe("custom");
    expect(f.desktopModel.latestModel).toBe("gpt-6.1-sol");
    expect(f.desktopModel.latestCollaborationMode).toEqual({
      mode: "plan",
      settings: { model: "gpt-6.1-sol", reasoning_effort: "high" },
    });
    expect(f.desktopModel.latestThreadSettings).toEqual({
      model: "gpt-6.1-sol",
      approvalPolicy: "never",
    });
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
