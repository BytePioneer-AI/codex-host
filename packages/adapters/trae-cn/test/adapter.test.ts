import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { harnessInspectionSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { TraeCnAdapter } from "../src/adapter.js";
import { modelRef } from "../src/models.js";

const { startServer } = createRequire(import.meta.url)("../assets/companion/server.cjs");

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-adapter-"));
  const root = path.join(directory, "resources", "app");
  const cwd = path.join(directory, "workspace");
  await mkdir(root, { recursive: true });
  await mkdir(cwd);
  await writeFile(path.join(root, "product.json"), JSON.stringify({ applicationName: "trae-cn" }));
  const application = {
    name: "Trae CN",
    version: "fixture",
    root,
    executable: path.join(directory, "Trae CN.exe"),
  };
  const user = {
    chat_session_id: "native-session",
    message_id: "user",
    message_index: 1,
    role: "user",
    content: '[{"type":"text","text_content":"hello"}]',
  };
  let items: unknown[] = [
    user,
    {
      chat_session_id: "native-session",
      message_id: "assistant",
      message_index: 2,
      role: "assistant",
      reply_to_message_id: "user",
      status: "completed",
      model: { config_name: "configured" },
      content: '{"messages":[]}',
    },
  ];
  const service = {
    application,
    workspaceFolders: [cwd],
    inspect: vi.fn(async () => ({
      application,
      workspaceFolders: [cwd],
      agentType: "builder_v3",
      models: [{ id: "configured", label: "Configured", provider: "native", multimodal: false }],
    })),
    call: vi.fn(async (method: string) => {
      if (method !== "snapshot") throw new Error("Unexpected native write during open");
      return { sessionId: "native-session", projectId: "project", workspaceFolders: [cwd], items };
    }),
    subscribe: vi.fn(),
  };
  const server = await startServer(service, path.join(directory, "discovery"));
  const adapter = new TraeCnAdapter({
    cwd,
    environment: { CODEXHOST_TRAE_CN_BRIDGE_DIR: path.join(directory, "discovery") },
  });
  const reference = nativeSessionRefSchema.parse({
    harnessId: "trae-cn",
    nativeSessionId: "native-session",
    formatVersion: 1,
    locator: { applicationRoot: root, cwd, projectId: "project", agentType: "builder_v3" },
  });
  return {
    adapter,
    service,
    reference,
    cwd,
    pending() {
      items = [user];
    },
    async close() {
      await adapter.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("TRAE CN public Adapter core", () => {
  it("caches the observed native model catalog in its scope without creating Sessions", async () => {
    const test = await setup();
    try {
      const first = harnessInspectionSchema.parse(await test.adapter.inspect());
      expect(first.status).toBe("ready");
      if (first.status !== "ready") throw new Error("Fixture is not ready");
      expect(first.catalog.defaultModel).toBeUndefined();
      expect(first.catalog.models[0]?.ref).toEqual(modelRef("builder_v3", "configured"));
      expect(await test.adapter.inspect()).toEqual(first);
      expect(test.service.inspect).toHaveBeenCalledOnce();
      await test.adapter.inspect({ refresh: true });
      expect(test.service.inspect).toHaveBeenCalledTimes(3);
      expect(test.service.call).not.toHaveBeenCalled();
      expect(test.service.subscribe).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("opens create lazily and resumes the exact native history read-only", async () => {
    const test = await setup();
    try {
      const created = await test.adapter.open({
        kind: "create",
        cwd: test.cwd,
        model: modelRef("builder_v3", "configured"),
      });
      expect(created.ok).toBe(true);
      expect(test.service.call).not.toHaveBeenCalled();
      if (created.ok) await created.value.close();
      const resumed = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
      });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState).toEqual({
        nativeRef: test.reference,
        effectiveModel: modelRef("builder_v3", "configured"),
      });
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: true,
        value: {
          turns: [{ nativeTurnRef: { nativeTurnKey: "user" }, outcome: { status: "succeeded" } }],
        },
      });
      expect(test.service.call.mock.calls.every((args) => args[0] === "snapshot")).toBe(true);
      await test.adapter.close();
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    } finally {
      await test.close();
    }
  });

  it("rejects foreign identities, pending history and unverified unattended permissions", async () => {
    const test = await setup();
    try {
      const foreign = nativeSessionRefSchema.parse({ ...test.reference, harnessId: "other" });
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: foreign }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(test.service.call).not.toHaveBeenCalled();
      test.pending();
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: test.reference }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      const before = test.service.inspect.mock.calls.length;
      expect(
        await test.adapter.open({
          kind: "create",
          cwd: test.cwd,
          executionPolicy: "unattended-full-access",
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(test.service.inspect).toHaveBeenCalledTimes(before);
    } finally {
      await test.close();
    }
  });
});
