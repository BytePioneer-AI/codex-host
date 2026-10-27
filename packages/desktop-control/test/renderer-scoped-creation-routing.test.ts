import { describe, expect, it, vi } from "vitest";
import { isolateRendererPrewarmConsumption } from "../src/renderer-prewarm-consumption.js";

const mode = (model: string) => ({
  mode: "default",
  settings: { model, reasoning_effort: "high" },
});
const draft = "client-new-thread:external";

function fixture() {
  const started = vi.fn<(input: unknown, options: unknown) => Promise<unknown>>(
    async (input) => input,
  );
  const creation = {
    params: {
      prewarmedThreadManager: {
        hasPrewarmedThread: () => false,
        consumePrewarmedThread: async () => null,
        deletePrewarmedThread: vi.fn(),
      },
    },
    createConversation: vi.fn(),
  };
  const manager = { threadCreation: creation, startConversation: started };
  const control = isolateRendererPrewarmConsumption(manager, vi.fn());
  if (!control) throw new Error("Native creation fixture is unavailable");
  return { manager, started, control, creation };
}

describe("draft-scoped native creation routing", () => {
  it("restores only the identified draft's route and preserves other creation inputs", async () => {
    const f = fixture();
    f.control.selectDraft(draft, "codexhost/pi-native");
    const input = {
      collaborationMode: mode("gpt-reserve"),
      permissionsConfig: { sandbox: "workspace-write" },
      input: [{ type: "text", text: "hello" }],
      cwd: "/project",
    };
    const options = { clientThreadId: draft, onSettled: vi.fn() };
    const result = await f.manager.startConversation(input, options);
    expect(result).toEqual({ ...input, collaborationMode: mode("codexhost/pi-native") });
    expect(input.collaborationMode.settings.model).toBe("gpt-reserve");
    expect(f.started).toHaveBeenCalledWith(result, options);
    expect(f.started.mock.contexts[0]).toBe(f.manager);
  });

  it("captures each invocation before asynchronous native preparation and later selection changes", async () => {
    const f = fixture();
    const ready = Promise.withResolvers<undefined>();
    f.started.mockImplementation(async (input) => {
      await ready.promise;
      return input;
    });
    f.control.selectDraft(draft, "codexhost/pi-native");
    f.control.selectDraft("client-new-thread:b", "codexhost/claude-code-native");
    const first = f.manager.startConversation(
      { collaborationMode: mode("gpt-reserve") },
      { clientThreadId: draft },
    );
    const second = f.manager.startConversation(
      { collaborationMode: mode("gpt-reserve") },
      { clientThreadId: "client-new-thread:b" },
    );
    f.control.selectDraft(draft, "codexhost/opencode-native");
    ready.resolve(undefined);
    await expect(first).resolves.toMatchObject({ collaborationMode: mode("codexhost/pi-native") });
    await expect(second).resolves.toMatchObject({
      collaborationMode: mode("codexhost/claude-code-native"),
    });
  });

  it("keeps official reserve, unrelated drafts and explicit schedules unchanged", async () => {
    const f = fixture();
    f.control.selectDraft(draft, "codexhost/pi-native");
    for (const options of [{}, { clientThreadId: "client-new-thread:official" }]) {
      const input = { collaborationMode: mode("gpt-reserve") };
      await expect(f.manager.startConversation(input, options)).resolves.toBe(input);
    }
    const scheduled = { collaborationMode: mode("codexhost/claude-code-native"), cwd: "/project" };
    const explicit = { collaborationMode: mode("codexhost/opencode-native") };
    await expect(f.manager.startConversation(explicit, { clientThreadId: draft })).resolves.toBe(
      explicit,
    );
    await expect(f.control.createScheduledConversation(scheduled, vi.fn())).resolves.toMatchObject({
      ...scheduled,
      input: [],
    });
  });

  it("preserves background origin through native mode copies without serializing metadata", async () => {
    const f = fixture();
    const sourceMode = mode("gpt-reserve");
    const serialized = JSON.stringify(sourceMode);
    f.control.selectDraft(draft, "codexhost/pi-native", [sourceMode]);
    const copied = { ...sourceMode, settings: { ...sourceMode.settings, reasoning_effort: "low" } };
    expect(JSON.stringify(copied)).toBe(
      JSON.stringify({
        ...JSON.parse(serialized),
        settings: { model: "gpt-reserve", reasoning_effort: "low" },
      }),
    );
    await expect(
      f.manager.startConversation(
        { collaborationMode: copied },
        { clientThreadId: "client-new-thread:background" },
      ),
    ).resolves.toMatchObject({
      collaborationMode: { settings: { model: "codexhost/pi-native", reasoning_effort: "low" } },
    });
    f.control.selectDraft(draft, null);
    const official = { collaborationMode: copied };
    await expect(f.manager.startConversation(official, { clientThreadId: draft })).resolves.toBe(
      official,
    );
    f.control.dispose();
    expect(f.manager.startConversation).toBe(f.started);
    expect(f.creation.createConversation).toHaveBeenCalledTimes(0);
  });

  it("clears all draft routes on adapter disposal and does not route through another Host", async () => {
    const local = fixture();
    const remote = fixture();
    local.control.selectDraft(draft, "codexhost/pi-native");
    const input = { collaborationMode: mode("gpt-reserve") };
    await expect(remote.manager.startConversation(input, { clientThreadId: draft })).resolves.toBe(
      input,
    );
    local.control.selectDraft(undefined, null);
    await expect(local.manager.startConversation(input, { clientThreadId: draft })).resolves.toBe(
      input,
    );
  });
});
