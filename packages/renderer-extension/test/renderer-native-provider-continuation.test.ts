import { describe, expect, it, vi } from "vitest";
import {
  continueNativeWithConfiguredProvider,
  inspectNativeProviderContinuation,
} from "../src/renderer-native-provider-continuation.js";

function fixture() {
  let provider = "openai";
  let loaded = true;
  let status = "idle";
  let defaultProvider = "custom";
  let otherConnection = false;
  const history = ["synthetic-user-marker", "synthetic-agent-reply"];
  const snapshot = {
    thread: { id: "history-thread" },
    modelProvider: "openai",
    model: "gpt-6.1-sol",
    cwd: "/work/project",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: ["/work/project"], networkAccess: false },
    serviceTier: null,
    reasoningEffort: "high",
    runtimeWorkspaceRoots: ["/work/project"],
    collaborationMode: null,
    disabledPluginIds: ["disabled-plugin"],
    activePermissionProfile: null as null | { id: string },
  };
  const implementation = async (method: string, input: unknown): Promise<unknown> => {
    const params = input as Record<string, unknown>;
    switch (method) {
      case "thread/read":
        return {
          thread: {
            id: "history-thread",
            modelProvider: provider,
            cliVersion: "0.159.2",
            cwd: snapshot.cwd,
            status: { type: loaded ? status : "notLoaded" },
          },
        };
      case "config/read":
        return {
          config: {
            model_provider: defaultProvider,
            model_providers: {
              custom: { base_url: "https://relay.example/v1", env_key: "SYNTHETIC_KEY" },
            },
          },
        };
      case "thread/resume":
        if (!loaded) provider = String(params.modelProvider ?? "openai");
        loaded = true;
        return { ...snapshot, modelProvider: provider };
      case "thread/unsubscribe":
        loaded = otherConnection;
        return { status: "unsubscribed" };
      case "thread/loaded/list":
        return { data: loaded ? ["history-thread"] : [] };
      case "thread/settings/update":
        return {};
      default:
        throw new Error(`Unexpected method ${method}`);
    }
  };
  const send = vi.fn(implementation);
  return {
    send,
    implementation,
    snapshot,
    history,
    provider: () => provider,
    setProvider: (id: string) => {
      provider = id;
    },
    setDefault: (id: string) => {
      defaultProvider = id;
    },
    setStatus: (type: string) => {
      status = type;
    },
    setOtherConnection: () => {
      otherConnection = true;
    },
  };
}

describe("Explicit configured Provider continuation for native history", () => {
  it("offers a verified independent default without changing a historical official session", async () => {
    const f = fixture();
    expect(await inspectNativeProviderContinuation(f.send, "history-thread")).toBe("custom");
    expect(f.provider()).toBe("openai");
    expect(f.send.mock.calls.map(([method]) => method)).toEqual(["thread/read", "config/read"]);
    expect(f.send).toHaveBeenLastCalledWith("config/read", {
      includeLayers: false,
      cwd: "/work/project",
    });
  });

  it.each(["active", "systemError"])(
    "does not offer a migration for %s Threads",
    async (status) => {
      const f = fixture();
      f.setStatus(status);
      expect(await inspectNativeProviderContinuation(f.send, "history-thread")).toBeNull();
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["custom", "unknown", "codexhost"])(
    "never claims %s is an official history",
    async (id) => {
      const f = fixture();
      f.setProvider(id);
      if (id === "codexhost") {
        await expect(inspectNativeProviderContinuation(f.send, "history-thread")).rejects.toThrow(
          /ownership/,
        );
      } else {
        expect(await inspectNativeProviderContinuation(f.send, "history-thread")).toBeNull();
      }
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["openai", "unknown"])(
    "rejects an unverified default %s before any mutation",
    async (id) => {
      const f = fixture();
      f.setDefault(id);
      await expect(
        continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
      ).rejects.toThrow(/no longer available/);
      expect(f.send.mock.calls.map(([method]) => method)).toEqual(["thread/read", "config/read"]);
    },
  );

  it("unloads and explicitly resumes the same history, preserving native runtime settings", async () => {
    const f = fixture();
    await continueNativeWithConfiguredProvider(f.send, "history-thread", "custom");
    expect(f.provider()).toBe("custom");
    expect(f.history).toEqual(["synthetic-user-marker", "synthetic-agent-reply"]);
    const resumes = f.send.mock.calls.filter(([method]) => method === "thread/resume");
    expect(resumes).toHaveLength(2);
    expect(resumes[0]?.[1]).toEqual({ threadId: "history-thread", excludeTurns: true });
    expect(resumes[1]?.[1]).toEqual({
      threadId: "history-thread",
      excludeTurns: true,
      model: "gpt-6.1-sol",
      modelProvider: "custom",
      cwd: "/work/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceTier: null,
      runtimeWorkspaceRoots: ["/work/project"],
      config: { model_reasoning_effort: "high" },
    });
    expect(f.send).toHaveBeenCalledWith("thread/settings/update", {
      threadId: "history-thread",
      sandboxPolicy: f.snapshot.sandbox,
      effort: "high",
      collaborationMode: null,
      disabledPluginIds: ["disabled-plugin"],
    });
    expect(
      f.send.mock.calls.some(([method]) => /turn\/|account\/|config\/.*write/.test(method)),
    ).toBe(false);
  });

  it("preserves named permission profiles rather than flattening them into sandbox modes", async () => {
    const f = fixture();
    f.snapshot.activePermissionProfile = { id: "restricted-project" };
    await continueNativeWithConfiguredProvider(f.send, "history-thread", "custom");
    const params = f.send.mock.calls.find(
      ([method, input]) =>
        method === "thread/resume" && (input as Record<string, unknown>).modelProvider === "custom",
    )?.[1];
    expect(params).toHaveProperty("permissions", "restricted-project");
    expect(params).not.toHaveProperty("sandbox");
    const settings = f.send.mock.calls.find(([method]) => method === "thread/settings/update")?.[1];
    expect(settings).toHaveProperty("permissions", "restricted-project");
    expect(settings).not.toHaveProperty("sandboxPolicy");
  });

  it("refuses a runtime that rejoins another owner's old Provider instead of adopting the change", async () => {
    const f = fixture();
    f.setOtherConnection();
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
    ).rejects.toThrow(/did not adopt/);
    expect(f.provider()).toBe("openai");
    expect(
      f.send.mock.calls.some(
        ([method, input]) =>
          method === "thread/resume" &&
          (input as Record<string, unknown>).modelProvider === "custom",
      ),
    ).toBe(true);
  });

  it("restores the original Provider when settings restoration fails after migration", async () => {
    const f = fixture();
    const original = f.implementation;
    let firstSettings = true;
    f.send.mockImplementation(async (method, input) => {
      if (method === "thread/settings/update" && firstSettings) {
        firstSettings = false;
        throw new Error("Synthetic settings failure");
      }
      return original(method, input);
    });
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
    ).rejects.toThrow("Synthetic settings failure");
    expect(f.provider()).toBe("openai");
    expect(f.history).toHaveLength(2);
  });

  it("rejects a mismatched native identity before detaching", async () => {
    const f = fixture();
    await expect(
      continueNativeWithConfiguredProvider(f.send, "foreign-thread", "custom"),
    ).rejects.toThrow(/ownership/);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("refuses unsubscription errors without treating them as a successful migration", async () => {
    const f = fixture();
    const original = f.implementation;
    f.send.mockImplementation(async (method, input) => {
      if (method === "thread/unsubscribe") return { status: "notSubscribed" };
      return original(method, input);
    });
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
    ).rejects.toThrow(/could not be unsubscribed/);
    expect(f.provider()).toBe("openai");
  });

  it("restores the original session if the configured Provider changes while detached", async () => {
    const f = fixture();
    const original = f.implementation;
    f.send.mockImplementation(async (method, input) => {
      const response = await original(method, input);
      if (method === "thread/unsubscribe") f.setDefault("openai");
      return response;
    });
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
    ).rejects.toThrow(/Provider changed/);
    expect(f.provider()).toBe("openai");
  });

  it("refuses a Turn that starts between eligibility and unsubscription", async () => {
    const f = fixture();
    const original = f.implementation;
    f.send.mockImplementation(async (method, input) => {
      const response = await original(method, input);
      if (method === "thread/resume") f.setStatus("active");
      return response;
    });
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
    ).rejects.toThrow(/Thread changed/);
    expect(f.send.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(false);
  });

  it("surfaces both migration and restoration failure rather than reporting success", async () => {
    const f = fixture();
    const original = f.implementation;
    f.send.mockImplementation(async (method, input) => {
      if (method === "thread/settings/update") throw new Error("Synthetic settings failure");
      return original(method, input);
    });
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
    ).rejects.toThrow(/continuation and restoration failed/);
  });
});
