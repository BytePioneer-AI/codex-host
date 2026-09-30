import { describe, expect, it, vi } from "vitest";
import { hostInteractionIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { cacheUsage, contextUsage } from "../src/models.js";
import { ZcodeSession } from "../src/session.js";
import { settingsSchema, snapshotSchema } from "../src/protocol.js";
import type { CliTransport } from "../src/transport.js";

const SESSION_ID = "native-session";
const snapshot = snapshotSchema.parse({
  protocol: { name: "ZCode Protocol", version: 1 },
  session: {
    sessionId: SESSION_ID,
    workspace: { workspacePath: "/workspace", workspaceKey: "workspace" },
    title: "",
    status: "idle",
    mode: "build",
    createdAt: 0,
    updatedAt: 0,
    sessionKind: "main",
  },
  settings: {
    model: { available: [] },
    thoughtLevel: { enabled: false, available: [] },
    mode: { current: "build" },
  },
  projection: { status: "idle", contextUsed: 0, contextWindow: 0 },
  messages: [],
  runtime: {},
});

function fixture() {
  let listener: ((value: unknown) => void) | undefined;
  const resolutions: unknown[] = [];
  // Each resolveInteraction command waits for the next queued native result.
  const nativeResults: PromiseWithResolvers<{ status: string }>[] = [];
  const closing = Promise.withResolvers<undefined>();
  const transport = {
    options: { cwd: "/workspace" },
    locator: { backend: "local-service" },
    onFault: undefined as ((error: Error) => void) | undefined,
    listen: vi.fn(async (_event: string, _params: unknown, next: (value: unknown) => void) => {
      listener = next;
      return async () => {};
    }),
    request: vi.fn(async () => snapshot),
    command: vi.fn(async (_sessionId: string, type: string, payload: unknown) => {
      if (type !== "resolveInteraction") return { status: "accepted" };
      resolutions.push(payload);
      const result = Promise.withResolvers<{ status: string }>();
      nativeResults.push(result);
      return result.promise;
    }),
    close: vi.fn(async () => closing.promise),
  };
  const onClose = vi.fn();
  const session = new ZcodeSession(transport as unknown as CliTransport, snapshot, onClose);
  return {
    session,
    transport,
    onClose,
    resolutions,
    nativeResults,
    closing,
    emit: (value: unknown) => listener?.(value),
  };
}

async function awaitApproval(state: ReturnType<typeof fixture>) {
  await state.session.subscribe();
  const turnId = hostTurnIdSchema.parse("turn-1");
  expect(
    await state.session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "go" }],
    }),
  ).toMatchObject({ ok: true });
  state.emit({
    type: "permission.request",
    request: {
      requestId: "approval-1",
      sessionId: SESSION_ID,
      toolName: "Bash",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once", response: { decision: "allow" } },
        { optionId: "deny", name: "Deny", kind: "reject_once", response: { decision: "deny" } },
      ],
    },
  });
}
const allow = {
  type: "interaction.respond",
  interactionId: hostInteractionIdSchema.parse("zcode:approval-1"),
  response: { type: "approval", actionId: "allow" },
} as const;

describe("ZCode Session lifecycle", () => {
  it("releases a faulted Session only after its service has stopped", async () => {
    const { session, transport, onClose, closing } = fixture();
    const outputs: string[] = [];
    void (async () => {
      for await (const output of session.outputs)
        if (output.kind === "event") outputs.push(output.event.type);
    })();
    transport.onFault?.(new Error("native service exited"));
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outputs).toEqual(["session.faulted"]);
    expect(onClose).not.toHaveBeenCalled();
    closing.resolve(undefined);
    await session.close();
    await session.close();
    expect(onClose).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("resolves a native approval once when Turn cleanup overlaps the user response", async () => {
    const state = fixture();
    await awaitApproval(state);
    const response = state.session.execute(allow);
    // Turn cleanup denies every open interaction while the approval is still in flight.
    state.transport.onFault?.(new Error("native service exited"));
    state.nativeResults[0]?.resolve({ status: "accepted" });
    await response;
    expect(state.resolutions).toEqual([
      { interactionId: "approval-1", answer: { optionId: "allow" } },
    ]);
    state.closing.resolve(undefined);
  });

  it("lets the user retry an approval whose native resolution was rejected", async () => {
    const state = fixture();
    await awaitApproval(state);
    const first = state.session.execute(allow);
    // CliTransport.command rejects when ZCode does not accept the command.
    state.nativeResults[0]?.reject(new Error("ZCode rejected resolveInteraction"));
    expect(await first).toMatchObject({ ok: false });
    const retry = state.session.execute(allow);
    await vi.waitFor(() => expect(state.nativeResults).toHaveLength(2));
    state.nativeResults[1]?.resolve({ status: "accepted" });
    expect(await retry).toMatchObject({ ok: true });
    expect(state.resolutions).toHaveLength(2);
  });
});

describe("ZCode context usage", () => {
  const current = { providerId: "deepseek", modelId: "deepseek-flash" };
  const catalog = (contextWindow?: number) =>
    settingsSchema.parse({
      model: {
        current,
        available: [
          {
            ref: { providerId: "other", modelId: "deepseek-flash" },
            label: "other",
            contextWindow: 64_000,
          },
          { ref: current, label: "deepseek-flash", ...(contextWindow ? { contextWindow } : {}) },
        ],
      },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    });
  const session = (projectionWindow: number) =>
    snapshotSchema.parse({
      ...snapshot,
      settings: { ...snapshot.settings, model: { current, available: [] } },
      projection: { status: "idle", contextUsed: 1_200, contextWindow: projectionWindow },
    });

  it("reports the selected Model's catalog window instead of the stale session projection", () => {
    expect(contextUsage(session(200_000), catalog(1_000_000))).toEqual({
      contextUsedTokens: 1_200,
      contextWindowTokens: 1_000_000,
    });
  });
  it("uses the session projection when the catalog has no window for the selected Model", () => {
    expect(contextUsage(session(200_000), catalog())).toEqual({
      contextUsedTokens: 1_200,
      contextWindowTokens: 200_000,
    });
  });
  it("reports nothing when neither source has a window", () => {
    expect(contextUsage(session(0), catalog())).toBeNull();
  });
});

describe("ZCode cache usage", () => {
  const withRuntime = (runtime: object) => snapshotSchema.parse({ ...snapshot, runtime });

  it("reports the Session's cache totals and the latest request's hit rate", () => {
    expect(
      cacheUsage(
        withRuntime({
          contextUsage: {
            cache: { totalCacheReadTokens: 900, totalCacheWriteTokens: 60, latestHitRate: 0.9 },
          },
        }),
      ),
    ).toEqual({ cachedInputTokens: 900, cacheWriteInputTokens: 60, cacheHitRatePercent: 90 });
  });
  it("omits the hit rate until ZCode reports one", () => {
    expect(
      cacheUsage(
        withRuntime({
          contextUsage: { cache: { totalCacheReadTokens: 0, totalCacheWriteTokens: 0 } },
        }),
      ),
    ).toEqual({ cachedInputTokens: 0, cacheWriteInputTokens: 0 });
  });
  it("reports nothing before the Session has cache state", () => {
    expect(cacheUsage(withRuntime({}))).toEqual({});
  });
});
