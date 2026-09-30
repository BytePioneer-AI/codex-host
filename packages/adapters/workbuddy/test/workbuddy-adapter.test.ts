import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeBuddyProjectSlug,
  CodeBuddyError,
  modelRef,
  type CodeBuddyClient,
  type CodeBuddyClientFactory,
} from "@codexhost/adapter-codebuddy";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";
import { WORKBUDDY_RUNTIME_PROFILE } from "../src/common.js";

const adapters: WorkBuddyAdapter[] = [];
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

function fakeFactory(nativeVersion: string | null = null): CodeBuddyClientFactory {
  return () =>
    ({
      nativeVersion,
      initialize: async () => ({ protocolVersion: 1 }),
      open: async (_cwd, sessionId) => ({
        sessionId: sessionId ?? "workbuddy-native",
        configOptions,
      }),
      steer: async () => ({ steered: true }),
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

describe("WorkBuddy Adapter identity", () => {
  it("declares steer only when the bundled CLI reports the acceptance receipt", async () => {
    const older = new WorkBuddyAdapter({ clientFactory: fakeFactory("2.137.1") });
    adapters.push(older);
    const opened = await older.open({ kind: "create", cwd: process.cwd(), environment: {} });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.capabilities.steer).toBeUndefined();
    const turnId = hostTurnIdSchema.parse("workbuddy-older");
    expect(
      await opened.value.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "now" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });

    const current = new WorkBuddyAdapter({ clientFactory: fakeFactory("2.143.1") });
    adapters.push(current);
    const ready = await current.open({ kind: "create", cwd: process.cwd(), environment: {} });
    if (!ready.ok) throw new Error(ready.error.message);
    expect(ready.value.capabilities.steer).toBe(true);
    expect(
      await ready.value.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("workbuddy-current"),
        input: [{ type: "text", text: "now" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(await current.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "ready",
      capabilities: { steer: true },
    });
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
