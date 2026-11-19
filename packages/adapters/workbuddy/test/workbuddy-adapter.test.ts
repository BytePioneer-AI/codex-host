import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseHostUsage,
  type HarnessOutput,
  type HarnessSession,
} from "@codexhost/harness-adapter";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  codeBuddyProjectSlug,
  CodeBuddyAdapter,
  CodeBuddyError,
  modelRef,
  type CodeBuddyClient,
  type CodeBuddyClientFactory,
} from "@codexhost/adapter-codebuddy";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";
import { WORKBUDDY_RUNTIME_PROFILE } from "../src/common.js";

const adapters: CodeBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

const configOptions = [
  {
    id: "model",
    currentValue: "native/model",
    options: [{ value: "native/model", name: "Native Model" }],
  },
  {
    id: "mode",
    currentValue: "default",
    options: ["default", "plan", "fullAccess"].map((value) => ({ value, name: value })),
  },
  {
    id: "thought_level",
    currentValue: "low",
    options: ["low", "high"].map((value) => ({ value, name: value })),
  },
];

function fakeFactory(): CodeBuddyClientFactory {
  return () =>
    ({
      initialize: async () => ({ protocolVersion: 1 }),
      open: async (_cwd, sessionId) => ({
        sessionId: sessionId ?? "workbuddy-native",
        configOptions,
      }),
      configure: async (_sessionId, id, value) => ({
        configOptions: configOptions.map((option) => ({
          ...option,
          currentValue: option.id === id ? value : option.currentValue,
        })),
      }),
      prompt: async () => ({ stopReason: "end_turn" }),
      cancel: async () => {},
      answer: async () => {},
      close: async () => {},
    }) satisfies CodeBuddyClient;
}

async function contextFixture(Adapter: typeof CodeBuddyAdapter, history = "") {
  let handlers: Parameters<CodeBuddyClientFactory>[0]["handlers"] | undefined;
  const options = (model = "native/model") =>
    configOptions.map((option) => ({
      ...option,
      type: "select" as const,
      name: option.id,
      ...(option.id === "model"
        ? {
            currentValue: model,
            options: [...option.options, { value: "other", name: "Other Model" }],
          }
        : {}),
    }));
  const configure = vi.fn<CodeBuddyClient["configure"]>(async (_sessionId, id, value) => ({
    configOptions: options().map((option) => ({
      ...option,
      currentValue: option.id === id ? value : option.currentValue,
    })),
  }));
  const adapter = new Adapter({
    environment: {},
    readHistory: async () => history,
    clientFactory: (context) => {
      handlers = context.handlers;
      return {
        ...fakeFactory()(context),
        open: async () => ({ sessionId: "context-session", configOptions: options() }),
        configure,
      };
    },
  });
  adapters.push(adapter);
  const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
  if (!opened.ok) throw Error(opened.error.message);
  const session = opened.value;
  const outputs: HarnessOutput[] = [];
  const collected = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return {
    session,
    outputs,
    configure,
    options,
    update(update: SessionNotification["update"]) {
      if (!handlers) throw Error("No native client");
      handlers.update({ sessionId: "context-session", update });
    },
    async usage() {
      await session.close();
      await collected;
      return outputs.flatMap((output) =>
        output.kind === "event" && output.event.type === "session.usage.changed"
          ? [output.event.usage === null ? null : parseHostUsage(output.event.usage)]
          : [],
      );
    },
  };
}

describe.each([
  { name: "CodeBuddy", Adapter: CodeBuddyAdapter },
  { name: "WorkBuddy", Adapter: WorkBuddyAdapter },
])("$name context ownership", ({ Adapter }) => {
  it("clears the previous context when a Model selection has no new usage", async () => {
    const f = await contextFixture(Adapter);
    f.update({ sessionUpdate: "usage_update", used: 30000, size: 300000 });
    expect(
      await f.session.execute({ type: "model.select", model: modelRef("other") }),
    ).toMatchObject({
      ok: true,
    });
    await f.session.refreshUsage?.();
    expect((await f.usage()).at(-1)).toBeNull();
    const cleared = f.outputs.findIndex(
      (output) =>
        output.kind === "event" &&
        output.event.type === "session.usage.changed" &&
        output.event.usage === null,
    );
    const changed = f.outputs.findIndex(
      (output) =>
        output.kind === "event" &&
        output.event.type === "session.state.changed" &&
        output.event.state.effectiveModel?.id === modelRef("other").id,
    );
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(changed).toBeGreaterThan(cleared);
  });

  it.each(["selection", "native update"])(
    "keeps cumulative usage when %s invalidates the context",
    async (trigger) => {
      const history = JSON.stringify({
        id: "assistant",
        type: "message",
        role: "assistant",
        content: "reply",
        providerData: {
          messageId: "request",
          model: "native/model",
          rawUsage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            credit: 2,
          },
        },
      });
      const f = await contextFixture(Adapter, history);
      await f.session.refreshUsage?.();
      f.update({ sessionUpdate: "usage_update", used: 30000, size: 300000 });
      if (trigger === "selection")
        expect(
          await f.session.execute({ type: "model.select", model: modelRef("other") }),
        ).toMatchObject({ ok: true });
      else f.update({ sessionUpdate: "config_option_update", configOptions: f.options("other") });
      await f.session.refreshUsage?.();
      const usage = (await f.usage()).at(-1);
      expect(usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        totalCredits: 2,
      });
    },
  );

  it.each(["before", "after"])(
    "handles usage arriving %s Model confirmation and before the configure response",
    async (timing) => {
      const f = await contextFixture(Adapter);
      f.update({ sessionUpdate: "usage_update", used: 30000, size: 300000 });
      f.configure.mockImplementationOnce(async () => {
        if (timing === "after")
          f.update({ sessionUpdate: "config_option_update", configOptions: f.options("other") });
        f.update({ sessionUpdate: "usage_update", used: 40000, size: 1000000 });
        return { configOptions: f.options("other") };
      });
      expect(
        await f.session.execute({ type: "model.select", model: modelRef("other") }),
      ).toMatchObject({ ok: true });
      const usage = await f.usage();
      expect(usage[0]).toMatchObject({ contextWindowTokens: 300000 });
      if (timing === "before") expect(usage.at(-1)).toBeNull();
      else {
        const firstNew = usage.findIndex((value) => value?.contextWindowTokens === 1000000);
        expect(firstNew).toBeGreaterThan(0);
        expect(usage.slice(firstNew)).toEqual(
          expect.arrayContaining([
            { contextUsedTokens: 40000, contextWindowTokens: 1000000, contextUsagePercent: 4 },
          ]),
        );
        expect(usage.slice(firstNew).every((value) => value?.contextWindowTokens === 1000000)).toBe(
          true,
        );
      }
    },
  );

  it.each([
    {
      name: "same Model",
      select: (session: HarnessSession) =>
        session.execute({ type: "model.select", model: modelRef("native/model") }),
    },
    {
      name: "Thinking",
      select: (session: HarnessSession) =>
        session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        }),
    },
    {
      name: "Permission Mode",
      select: (session: HarnessSession) =>
        session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        }),
    },
  ])("keeps context across $name selection without a Model change", async ({ select }) => {
    const f = await contextFixture(Adapter);
    f.update({ sessionUpdate: "usage_update", used: 30000, size: 300000 });
    expect(await select(f.session)).toMatchObject({ ok: true });
    f.update({ sessionUpdate: "config_option_update", configOptions: f.options() });
    expect((await f.usage()).every((usage) => usage?.contextWindowTokens === 300000)).toBe(true);
  });
});

describe("WorkBuddy Adapter identity", () => {
  it.each(["notification", "explicit refresh"])(
    "publishes persisted requests before Turn completion on %s",
    async (trigger) => {
      let context: Parameters<CodeBuddyClientFactory>[0] | undefined;
      let history = "";
      const pending = Promise.withResolvers<Record<string, unknown>>();
      const adapter = new WorkBuddyAdapter({
        readHistory: async () => history,
        clientFactory: (options) => {
          context = options;
          return { ...fakeFactory()(options), prompt: () => pending.promise };
        },
      });
      adapters.push(adapter);
      const opened = await adapter.open({ kind: "create", cwd: process.cwd(), environment: {} });
      if (!opened.ok) throw Error(opened.error.message);
      const session = opened.value;
      const outputs: HarnessOutput[] = [];
      const collected = (async () => {
        for await (const output of session.outputs) outputs.push(output);
      })();
      try {
        expect(
          await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("usage-turn"),
            input: [{ type: "text", text: "inspect" }],
          }),
        ).toMatchObject({ ok: true });
        // Two persisted requests matching the reported WorkBuddy token totals. The native
        // prompt remains pending (e.g. waiting for a tool permission), not a finished Turn.
        history =
          [
            { id: "user", type: "message", role: "user", content: "inspect" },
            ...[28905, 28931].map((input, index) => ({
              id: `assistant-${index}`,
              parentId: index ? "assistant-0" : "user",
              type: "message",
              role: "assistant",
              content: "reply",
              providerData: {
                messageId: `request-${index}`,
                model: "deepseek-v4.1-flash",
                rawUsage: {
                  prompt_tokens: input,
                  completion_tokens: index ? 204 : 9,
                  total_tokens: input + (index ? 204 : 9),
                  prompt_tokens_details: { cached_tokens: 28672 },
                  prompt_cache_write_tokens: 0,
                  completion_thinking_tokens: index ? 35 : 0,
                  credit: 0,
                },
              },
            })),
          ]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n";
        if (!context) throw Error("No native client");
        const refresh = async () => {
          if (trigger === "explicit refresh") await session.refreshUsage?.();
          else
            context?.handlers.update({
              sessionId: "workbuddy-native",
              update: {
                sessionUpdate: "usage_update",
                used: 28931,
                size: 185000,
              },
            });
        };
        await refresh();
        await vi.waitFor(() =>
          expect(outputs).toContainEqual({
            kind: "event",
            event: {
              type: "session.usage.changed",
              usage: expect.objectContaining({
                inputTokens: 57836,
                outputTokens: 213,
                cachedInputTokens: 57344,
                cacheHitRatePercent: (28672 / 28931) * 100,
                reasoningOutputTokens: 35,
              }),
            },
          }),
        );
        const requests = () =>
          outputs.filter((o) => o.kind === "event" && o.event.type === "usage.request");
        expect(requests()).toHaveLength(2);
        expect(requests()[0]).toMatchObject({
          event: {
            request: {
              model: "deepseek-v4.1-flash",
              cachedInputTokens: 28672,
            },
          },
        });
        await refresh();
        await session.refreshUsage?.();
        expect(requests()).toHaveLength(2);
        expect(outputs.some((o) => o.kind === "event" && o.event.type === "turn.completed")).toBe(
          false,
        );
      } finally {
        await session.close();
        pending.resolve({ stopReason: "cancelled" });
        await collected;
      }
    },
  );
  it("keeps refresh failures and late reads from changing Session lifecycle", async () => {
    const read = Promise.withResolvers<string>();
    const readHistory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Native history is mid-append"))
      .mockReturnValueOnce(read.promise);
    const adapter = new WorkBuddyAdapter({ clientFactory: fakeFactory(), readHistory });
    adapters.push(adapter);
    const opened = await adapter.open({ kind: "create", cwd: process.cwd(), environment: {} });
    if (!opened.ok) throw Error(opened.error.message);
    const session = opened.value;
    const outputs: HarnessOutput[] = [];
    const collected = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    try {
      await expect(session.refreshUsage?.()).resolves.toBeUndefined();
      const refresh = session.refreshUsage?.();
      // An overlapping notification must not start another file read.
      await session.refreshUsage?.();
      expect(readHistory).toHaveBeenCalledTimes(2);
      await session.close();
      read.resolve("");
      await refresh;
      await collected;
      expect(outputs).toEqual([
        { kind: "event", event: { type: "usage.history", complete: true } },
      ]);
    } finally {
      read.resolve("");
      await session.close();
      await collected;
    }
  });

  it("opens WorkBuddy Sessions with WorkBuddy native identity and honest history capabilities", async () => {
    const adapter = new WorkBuddyAdapter({ clientFactory: fakeFactory() });
    adapters.push(adapter);
    const opened = await adapter.open({ kind: "create", cwd: process.cwd(), environment: {} });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(adapter.harnessId).toBe("workbuddy");
    expect(opened.value).toMatchObject({
      harnessId: "workbuddy",
      initialState: {
        nativeRef: {
          harnessId: "workbuddy",
          nativeSessionId: "workbuddy-native",
          formatVersion: 1,
        },
      },
      capabilities: {
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
        subagents: { observe: true, readTranscript: true },
      },
    });
  });

  it("adds deduplicated WorkBuddy product-file Models to the selectable catalog", async () => {
    const adapter = new WorkBuddyAdapter({
      platform: "win32",
      clientFactory: fakeFactory(),
      productModels: async () => [
        { id: "native/model", name: "Native Model" },
        { id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" },
        { id: "glm-5.2-alias", name: "glm-5.2", credits: "x0.79 credits" },
      ],
    });
    adapters.push(adapter);

    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "ready",
      catalog: {
        models: [{ label: "Native Model" }, { label: "GLM-5.2 · 0.79x" }],
      },
    });
  });

  it("selects a product-file Model even when ACP omits it from the option rows", async () => {
    const adapter = new WorkBuddyAdapter({
      platform: "win32",
      clientFactory: fakeFactory(),
      productModels: async () => [{ id: "glm-5.2", name: "GLM-5.2" }],
    });
    adapters.push(adapter);

    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      environment: {},
      model: modelRef("glm-5.2"),
    });

    expect(opened).toMatchObject({
      ok: true,
      value: {
        initialState: {
          effectiveModel: modelRef("glm-5.2"),
          resolvedModelLabel: "glm-5.2",
        },
      },
    });
  });

  it("keeps macOS on the ACP catalog and rejects Models omitted by ACP", async () => {
    const adapter = new WorkBuddyAdapter({
      platform: "darwin",
      clientFactory: fakeFactory(),
      productModels: async () => [{ id: "glm-5.2", name: "GLM-5.2" }],
    });
    adapters.push(adapter);

    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "ready",
      catalog: { models: [{ label: "Native Model" }] },
    });
    expect(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: {},
        model: modelRef("glm-5.2"),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("rejects CodeBuddy refs instead of crossing Harness history", async () => {
    const adapter = new WorkBuddyAdapter({ clientFactory: fakeFactory() });
    adapters.push(adapter);
    expect(
      await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "codebuddy",
          nativeSessionId: "native",
          formatVersion: 1,
        }),
      }),
    ).toMatchObject({
      error: { code: "invalidRequest", message: expect.stringContaining("WorkBuddy") },
    });
  });

  it("reads default history only from .workbuddy-ai", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "codexhost-workbuddy-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "codexhost-workbuddy-cwd-"));
    const sessionId = "workbuddy-history";
    const slug = codeBuddyProjectSlug(cwd, WORKBUDDY_RUNTIME_PROFILE);
    const workBuddyProject = path.join(home, ".workbuddy-ai", "projects", slug);
    const codeBuddyProject = path.join(home, ".codebuddy", "projects", slug);
    await Promise.all([
      mkdir(workBuddyProject, { recursive: true }),
      mkdir(codeBuddyProject, { recursive: true }),
    ]);
    const rows = (input: string) =>
      [
        { type: "message", role: "user", id: "user", sessionId, cwd, content: input },
        {
          type: "message",
          role: "assistant",
          id: "assistant",
          parentId: "user",
          sessionId,
          cwd,
          status: "completed",
          content: "done",
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n");
    await Promise.all([
      writeFile(path.join(workBuddyProject, `${sessionId}.jsonl`), rows("from WorkBuddy")),
      writeFile(path.join(codeBuddyProject, `${sessionId}.jsonl`), rows("from CodeBuddy")),
    ]);

    const adapter = new WorkBuddyAdapter({
      environment: { HOME: home, CODEBUDDY_CONFIG_DIR: path.join(home, ".codebuddy") },
      clientFactory: fakeFactory(),
    });
    adapters.push(adapter);
    const opened = await adapter.open({
      kind: "resume",
      cwd,
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "workbuddy",
        nativeSessionId: sessionId,
        formatVersion: 1,
      }),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await opened.value.readSnapshot()).toMatchObject({
      value: { turns: [{ input: [{ text: "from WorkBuddy" }] }] },
    });
  });

  it("brands authentication failures as WorkBuddy", async () => {
    const adapter = new WorkBuddyAdapter({
      clientFactory: () => {
        throw new CodeBuddyError("authenticationRequired", "Authentication required");
      },
    });
    adapters.push(adapter);
    expect(await adapter.inspect()).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired", message: "WorkBuddy: Authentication required" },
    });
  });
});
