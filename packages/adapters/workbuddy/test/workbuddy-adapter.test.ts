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
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
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

function fakeFactory(onCreate?: (environment: NodeJS.ProcessEnv) => void): CodeBuddyClientFactory {
  return (options) => {
    onCreate?.(options.environment);
    return {
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
    } satisfies CodeBuddyClient;
  };
}

describe("WorkBuddy Adapter identity", () => {
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

  it("injects only the live Windows App snapshot and removes stale product files", async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const serialized = JSON.stringify({
      agents: [{ name: "cli", models: ["glm-5.2"] }],
      models: [{ id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" }],
    });
    const adapter = new WorkBuddyAdapter({
      platform: "win32",
      environment: {
        ACC_PRODUCT_CONFIG_PATH: "C:\\stale\\acc-product-config-v3.json",
        ACC_PRODUCT_CONFIG_V2: "stale-inline",
        CODEXHOST_LAUNCHER_EXECUTABLE: "C:\\codexhost\\codexhost.exe",
      },
      clientFactory: fakeFactory((environment) => environments.push(environment)),
      productDesktopExecutable: () => "D:\\WorkBuddy\\WorkBuddyAI.exe",
      productSnapshotReader: async (environment, executable) => {
        expect(environment).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
        expect(environment).not.toHaveProperty("ACC_PRODUCT_CONFIG_V2");
        expect(environment.CODEXHOST_WORKBUDDY_DISABLE_PRODUCT_CACHE).toBe("1");
        expect(executable).toBe("D:\\WorkBuddy\\WorkBuddyAI.exe");
        return {
          serialized,
          models: [{ id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" }],
        };
      },
    });
    adapters.push(adapter);

    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "ready",
      catalog: {
        models: [{ label: "Native Model" }, { label: "GLM-5.2 · 0.79x" }],
      },
    });
    expect(environments).toHaveLength(1);
    expect(environments[0]).toMatchObject({ ACC_PRODUCT_CONFIG_V3: serialized });
    expect(environments[0]).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
    expect(environments[0]).not.toHaveProperty("ACC_PRODUCT_CONFIG_V2");
    expect(environments[0]?.CODEXHOST_WORKBUDDY_DISABLE_PRODUCT_CACHE).toBe("1");
  });

  it("shows no extended Windows Models when the live App snapshot cannot be read", async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const adapter = new WorkBuddyAdapter({
      platform: "win32",
      environment: { ACC_PRODUCT_CONFIG_PATH: "C:\\stale\\acc-product-config-v3.json" },
      clientFactory: fakeFactory((environment) => environments.push(environment)),
      productDesktopExecutable: () => "D:\\WorkBuddy\\WorkBuddyAI.exe",
      productSnapshotReader: async () => undefined,
    });
    adapters.push(adapter);

    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "ready",
      catalog: { models: [{ label: "Native Model" }] },
    });
    expect(environments[0]).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
    expect(environments[0]).not.toHaveProperty("ACC_PRODUCT_CONFIG_V3");
    expect(environments[0]?.CODEXHOST_WORKBUDDY_DISABLE_PRODUCT_CACHE).toBe("1");
  });

  it("selects a live product Model even when ACP omits it from the option rows", async () => {
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

  it("rejects stale Windows Models not present in the live App snapshot", async () => {
    const adapter = new WorkBuddyAdapter({
      platform: "win32",
      clientFactory: fakeFactory(),
      productModels: async () => [{ id: "glm-5.2", name: "GLM-5.2" }],
    });
    adapters.push(adapter);

    expect(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: {},
        model: modelRef("deepseek-v4-flash"),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });

  it("keeps macOS on the ACP catalog and product environment unchanged", async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const adapter = new WorkBuddyAdapter({
      platform: "darwin",
      environment: { ACC_PRODUCT_CONFIG_PATH: "/current/product.json" },
      clientFactory: fakeFactory((environment) => environments.push(environment)),
      productModels: async () => [{ id: "glm-5.2", name: "GLM-5.2" }],
    });
    adapters.push(adapter);

    expect(await adapter.inspect({ cwd: process.cwd() })).toMatchObject({
      status: "ready",
      catalog: { models: [{ label: "Native Model" }] },
    });
    expect(environments[0]?.ACC_PRODUCT_CONFIG_PATH).toBe("/current/product.json");
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
