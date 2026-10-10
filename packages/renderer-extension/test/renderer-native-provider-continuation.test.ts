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
  let defaultModel: string | undefined;
  let otherConnection = false;
  let turnStatuses: string[] | undefined;
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
    collaborationMode: null as null | {
      mode: string;
      settings: { model: string; reasoning_effort: string };
    },
    disabledPluginIds: ["disabled-plugin"],
    activePermissionProfile: null as null | { id: string },
  };
  let runtimeModel = snapshot.model;
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
            ...(params.includeTurns && turnStatuses
              ? { turns: turnStatuses.map((status, index) => ({ id: `turn-${index}`, status })) }
              : {}),
          },
        };
      case "config/read":
        return {
          config: {
            model_provider: defaultProvider,
            ...(defaultModel ? { model: defaultModel } : {}),
            model_providers: {
              custom: { base_url: "https://relay.example/v1", env_key: "SYNTHETIC_KEY" },
              "cc-switch-official": {
                base_url: "http://127.0.0.1:15721/v1",
                requires_openai_auth: true,
              },
            },
          },
        };
      case "thread/resume":
        if (!loaded) {
          provider = String(params.modelProvider ?? "openai");
          runtimeModel = String(params.model ?? snapshot.model);
        }
        loaded = true;
        return { ...snapshot, modelProvider: provider, model: runtimeModel };
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
    model: () => runtimeModel,
    setProvider: (id: string) => {
      provider = id;
    },
    setDefault: (id: string) => {
      defaultProvider = id;
    },
    setDefaultModel: (model: string) => {
      defaultModel = model;
    },
    setStatus: (type: string) => {
      status = type;
    },
    setTurnStatuses: (statuses: string[]) => {
      turnStatuses = statuses;
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
      expect(f.send).toHaveBeenCalledTimes(status === "systemError" ? 2 : 1);
    },
  );

  it("recovers a failed-authentication Thread only after every Turn is terminal", async () => {
    const f = fixture();
    f.setProvider("custom");
    f.setDefault("cc-switch-official");
    f.setDefaultModel("gpt-6-sol");
    f.setStatus("systemError");
    f.setTurnStatuses(["completed", "interrupted", "failed"]);
    expect(await inspectNativeProviderContinuation(f.send, "history-thread")).toBe(
      "cc-switch-official",
    );
    await continueNativeWithConfiguredProvider(f.send, "history-thread", "cc-switch-official");
    expect(f.provider()).toBe("cc-switch-official");
    expect(f.model()).toBe("gpt-6-sol");
  });

  it.each(
    [[], ["inProgress"], ["completed", "inProgress", "failed"], ["unknown"]].map((statuses) => ({
      statuses,
    })),
  )("blocks error recovery with nonterminal or unproven Turns %j", async ({ statuses }) => {
    const f = fixture();
    f.setStatus("systemError");
    f.setTurnStatuses(statuses);
    expect(await inspectNativeProviderContinuation(f.send, "history-thread")).toBeNull();
    expect(f.send.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(false);
  });

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
      expect(f.send).toHaveBeenCalledTimes(id === "codexhost" ? 1 : 2);
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

  it.each(["openai", "cc-switch-official"])(
    "offers and restores %s from independent historical routing without relying on a quota banner",
    async (providerId) => {
      const f = fixture();
      f.setProvider("custom");
      f.setDefault(providerId);
      expect(await inspectNativeProviderContinuation(f.send, "history-thread")).toBe(providerId);
      expect(f.provider()).toBe("custom");
      await continueNativeWithConfiguredProvider(f.send, "history-thread", providerId);
      expect(f.provider()).toBe(providerId);
      expect(f.history).toHaveLength(2);
      expect(f.send.mock.calls.some(([method]) => method.startsWith("turn/"))).toBe(false);
    },
  );

  it("adopts the configured Model so a Copilot-only alias is not retained on official switchback", async () => {
    const f = fixture();
    f.setProvider("custom");
    f.setDefault("cc-switch-official");
    f.setDefaultModel("gpt-6-sol");
    f.snapshot.collaborationMode = {
      mode: "default",
      settings: { model: "gpt-6.1-sol", reasoning_effort: "high" },
    };
    await continueNativeWithConfiguredProvider(f.send, "history-thread", "cc-switch-official");
    expect(f.model()).toBe("gpt-6-sol");
    expect(f.send).toHaveBeenCalledWith(
      "thread/settings/update",
      expect.objectContaining({
        collaborationMode: {
          mode: "default",
          settings: { model: "gpt-6-sol", reasoning_effort: "high" },
        },
        sandboxPolicy: f.snapshot.sandbox,
        effort: "high",
      }),
    );
  });

  it.each([
    { requires_openai_auth: false },
    { requires_openai_auth: true, experimental_bearer_token: "PROXY_MANAGED" },
    { requires_openai_auth: true, env_key: "SYNTHETIC_KEY" },
    { requires_openai_auth: true, base_url: "file:///synthetic" },
  ])("refuses an official namespace with non-native authentication: %j", async (override) => {
    const f = fixture();
    f.setProvider("custom");
    f.setDefault("cc-switch-official");
    const original = f.implementation;
    f.send.mockImplementation(async (method, input) => {
      if (method === "config/read") {
        return {
          config: {
            model_provider: "cc-switch-official",
            model_providers: {
              custom: { base_url: "https://relay.example/v1", env_key: "SYNTHETIC_KEY" },
              "cc-switch-official": { base_url: "http://127.0.0.1:15721/v1", ...override },
            },
          },
        };
      }
      return original(method, input);
    });
    expect(await inspectNativeProviderContinuation(f.send, "history-thread")).toBeNull();
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "cc-switch-official"),
    ).rejects.toThrow(/no longer available/);
    expect(f.send.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(false);
  });

  it("restores the independent Provider, Model and collaboration settings if official switchback fails", async () => {
    const f = fixture();
    f.setProvider("custom");
    f.setDefault("cc-switch-official");
    f.setDefaultModel("gpt-6-sol");
    f.snapshot.collaborationMode = {
      mode: "default",
      settings: { model: "gpt-6.1-sol", reasoning_effort: "high" },
    };
    const original = f.implementation;
    let fail = true;
    f.send.mockImplementation(async (method, input) => {
      if (method === "thread/settings/update" && fail) {
        fail = false;
        throw new Error("Synthetic official switchback failure");
      }
      return original(method, input);
    });
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "cc-switch-official"),
    ).rejects.toThrow("Synthetic official switchback failure");
    expect(f.provider()).toBe("custom");
    expect(f.model()).toBe("gpt-6.1-sol");
    expect(f.send).toHaveBeenLastCalledWith(
      "thread/settings/update",
      expect.objectContaining({ collaborationMode: f.snapshot.collaborationMode }),
    );
  });

  it("aborts and restores if the configured Model changes while detaching", async () => {
    const f = fixture();
    f.setProvider("custom");
    f.setDefault("cc-switch-official");
    f.setDefaultModel("gpt-6-sol");
    const original = f.implementation;
    f.send.mockImplementation(async (method, input) => {
      const value = await original(method, input);
      if (method === "thread/unsubscribe") f.setDefaultModel("gpt-other");
      return value;
    });
    await expect(
      continueNativeWithConfiguredProvider(f.send, "history-thread", "cc-switch-official"),
    ).rejects.toThrow(/Provider or Model changed/);
    expect(f.provider()).toBe("custom");
    expect(f.model()).toBe("gpt-6.1-sol");
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
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.setOtherConnection();
      const assertion = expect(
        continueNativeWithConfiguredProvider(f.send, "history-thread", "custom"),
      ).rejects.toThrow(/not released/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(f.provider()).toBe("openai");
      expect(
        f.send.mock.calls.some(
          ([method, input]) =>
            method === "thread/resume" &&
            (input as Record<string, unknown>).modelProvider === "custom",
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for actual delayed unloading before constructing the new Provider client", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const original = f.implementation;
      let detachedAt: number | null = null;
      f.send.mockImplementation(async (method, input) => {
        if (
          method === "thread/loaded/list" &&
          detachedAt !== null &&
          Date.now() - detachedAt < 60_000
        ) {
          return { data: ["history-thread"] };
        }
        if (method === "thread/unsubscribe") detachedAt = Date.now();
        if (method === "thread/resume" && detachedAt !== null) {
          expect(Date.now() - detachedAt).toBeGreaterThanOrEqual(60_000);
        }
        return original(method, input);
      });
      const continuation = continueNativeWithConfiguredProvider(f.send, "history-thread", "custom");
      await vi.runAllTimersAsync();
      await continuation;
      expect(f.provider()).toBe("custom");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks all loaded-Thread pages rather than mistaking the first page for unloading", async () => {
    const f = fixture();
    const original = f.implementation;
    const loadedParams: unknown[] = [];
    f.send.mockImplementation(async (method, input) => {
      if (method === "thread/loaded/list") {
        loadedParams.push(input);
        return (input as Record<string, unknown>).cursor
          ? { data: [] }
          : { data: ["other-thread"], nextCursor: "page-two" };
      }
      return original(method, input);
    });
    await continueNativeWithConfiguredProvider(f.send, "history-thread", "custom");
    expect(loadedParams).toEqual([{ limit: 100 }, { limit: 100, cursor: "page-two" }]);
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
    ).rejects.toThrow(/Provider or Model changed/);
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
