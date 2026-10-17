import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SharedWebCodexOwner } from "../src/web-codex-owner.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { startClientChannelServer } from "../src/client-channel-server.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function json(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "web-codex-owner-integration-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const plugins = join(root, "plugins"),
    home = join(root, "isolated-home"),
    data = join(root, "host"),
    source = join(root, "legacy-web");
  mkdirSync(home);
  mkdirSync(join(plugins, "codex"), { recursive: true });
  json(join(plugins, "codex", "manifest.json"), {
    manifestVersion: 1,
    id: "codex",
    name: "Synthetic Codex",
    version: "1.0.0",
    adapterApiVersion: 1,
    entry: "./plugin.mjs",
  });
  writeFileSync(
    join(plugins, "codex", "plugin.mjs"),
    `
export function createHarnessAdapter(context) {
  return { harnessId: 'codex', inspect: async () => ({ status:'ready', catalog:{ models:[{ref:{id:'fake'},label:'Fake'}],defaultModel:{id:'fake'},thinkingOptions:[] }, capabilities:{configuration:{selectModel:true,selectThinkingOption:false,selectPermissionMode:false},history:{fork:false,forkAcrossCwd:false,rollbackLastTurn:false}} }),
    open: async () => { throw new Error('No model submissions in this test'); }, close: async () => {} };
}
`,
  );
  const metadata = {
    sessionId: "kept",
    cwd: root,
    createdAt: 1,
    updatedAt: 2,
    blank: false,
    harnessId: "codex",
    nativeRef: { harnessId: "codex", nativeSessionId: "native-kept", locator: { codexHome: home } },
    checkpoints: { "1": { nativeTurnKey: "native-turn" } },
  };
  json(join(source, "codex-sessions", "sessions", "index.json"), { kept: metadata });
  json(join(source, "codex-sessions", "sessions", "kept", "projections.json"), {
    title: "Old title",
  });
  writeFileSync(
    join(source, "codex-sessions", "sessions", "kept", "events.jsonl"),
    JSON.stringify({ seq: 0, type: "session/title", time: 1, data: { title: "Old title" } }) + "\n",
  );
  json(join(source, "workspaces.json"), {
    items: [
      {
        workspaceId: "workspace",
        path: root,
        title: "Original",
        origin: "web",
        sessionIds: ["kept", "external"],
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
      },
    ],
    archivedSessionIds: [],
    pinnedSessionIds: ["kept"],
  });
  const environment = {
    HOME: join(root, "user"),
    CODEXHOST_DATA_DIR: data,
    CODEXHOST_GUI_CODEX_HOME: join(root, "official-home"),
  };
  const preferences = async (_method: string, input: Record<string, unknown>) => ({
    scope: input.scope,
    revision: 0,
    values: { favorites: {} },
  });
  const events = new ClientChannelEvents();
  const owner = new SharedWebCodexOwner(
    environment,
    events,
    async (id) => id === "official-id",
    preferences,
  );
  cleanup.push(() => owner.close());
  const server = await startClientChannelServer({
    target: {
      clientEvents: events,
      webCodex: owner,
      handleClientRequest: async () => {
        throw new Error("external route unused");
      },
      clientSnapshot: async () => {
        throw new Error("external route unused");
      },
      respondClient: async () => ({ resolved: false }),
    },
    environment,
    directory: join(data, "client-hosts"),
  });
  cleanup.push(() => server.close());
  const post = async (route: string, value: unknown, authenticated = true) => {
    const response = await fetch(
      `http://127.0.0.1:${server.descriptor.port}/v1/web-codex/${route}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: `Bearer ${server.descriptor.token}` } : {}),
        },
        body: JSON.stringify(value),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as { result?: unknown; error?: { message: string } },
    };
  };
  const configuration = { home, command: process.execPath, pluginRoots: [plugins] };
  return {
    root,
    plugins,
    home,
    data,
    source,
    environment,
    preferences,
    owner,
    events,
    server,
    post,
    configuration,
  };
}

describe("production owner over private authenticated HTTP", () => {
  it.skipIf(process.platform === "win32")(
    "runs the existing Host maintenance entry after a confirmed synthetic launcher stop",
    async () => {
      const f = await fixture();
      const configured = await f.post("configure", {
        ...f.configuration,
        migrateSource: f.source,
        legacyWriterStopped: true,
      });
      expect(configured.status).toBe(200);
      await f.owner.close();
      const launcher = join(f.root, "synthetic-launcher.mjs"),
        stopArguments = join(f.root, "stop-arguments.json");
      writeFileSync(
        launcher,
        `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(stopArguments)}, JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o700 },
      );
      const result = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("../dist/main.js", import.meta.url)),
        "--codexhost-web-codex-rollback",
        "--data",
        f.data,
        "--home",
        f.home,
        "--launcher",
        launcher,
      ]);
      expect(result.stderr).toContain("migration rolled back");
      expect(JSON.parse(readFileSync(stopArguments, "utf8")).slice(0, 2)).toEqual(["host", "stop"]);
      expect(existsSync(join(f.data, "web-codex", "service-config-v1.json"))).toBe(false);
      expect(existsSync(join(f.source, "codex-sessions", "source-migrated-v1.json"))).toBe(false);
      expect(existsSync(join(f.data, "web-codex", "migration-rolled-back-v1.json"))).toBe(true);
      const recovered = new SharedWebCodexOwner(
        f.environment,
        new ClientChannelEvents(),
        async () => false,
        f.preferences,
      );
      cleanup.push(() => recovered.close());
      await recovered.initialize();
      await expect(recovered.configure(f.configuration)).rejects.toThrow("migration-rolled-back");
      const remigrated = await recovered.configure({
        ...f.configuration,
        migrateSource: f.source,
        legacyWriterStopped: true,
      });
      expect(remigrated.sessionIds).toEqual(["kept"]);
      expect(existsSync(join(f.data, "web-codex", "migration-rolled-back-v1.json"))).toBe(false);
    },
  );
  it("migrates one source, persists only local organization and restores it after owner restart", async () => {
    const f = await fixture();
    const unauthorized = await f.post("configure", f.configuration, false);
    expect(unauthorized.status).toBe(401);
    const migrated = await f.post("configure", {
      ...f.configuration,
      migrateSource: f.source,
      legacyWriterStopped: true,
    });
    expect(migrated.status).toBe(200);
    const reply = migrated.body.result as { scope: string; sessionIds: string[] };
    expect(reply.sessionIds).toEqual(["kept"]);
    expect(
      (
        await f.post("configure", {
          ...f.configuration,
          migrateSource: f.source,
          legacyWriterStopped: true,
        })
      ).body.result,
    ).toEqual(migrated.body.result);
    expect(existsSync(join(f.data, "web-codex", "migration-mutated-v1.json"))).toBe(false);
    const request = (action: string, input: Record<string, unknown> = {}) =>
      f.post("request", {
        epoch: f.events.epoch,
        address: { scope: reply.scope, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
        operation: "organization",
        input: { action, ...input },
      });
    const snapshot = (await request("snapshot")).body.result as {
      items: Array<{ sessionIds: string[] }>;
    };
    expect(snapshot.items[0]?.sessionIds).toEqual(["kept"]);
    expect((await request("rename", { workspaceId: "workspace", title: "Confirmed" })).status).toBe(
      200,
    );
    expect((await request("archive", { sessionId: "kept" })).status).toBe(200);
    const denied = await request("pin", { sessionId: "official-id" });
    expect(denied.body.error?.message).toContain("session-not-found");
    expect(existsSync(join(f.data, "web-codex", "migration-mutated-v1.json"))).toBe(true);
    await f.owner.close();
    const recovered = new SharedWebCodexOwner(
      f.environment,
      new ClientChannelEvents(),
      async () => false,
      f.preferences,
    );
    cleanup.push(() => recovered.close());
    await recovered.initialize();
    const description = await recovered.configure(f.configuration);
    const restored = (await recovered.request({
      epoch: description.cursor.epoch,
      address: { scope: description.scope },
      operation: "organization",
      input: { action: "snapshot" },
    })) as {
      items: Array<{ title: string }>;
      archivedSessionIds: string[];
      pinnedSessionIds: string[];
    };
    expect(restored.items[0]?.title).toBe("Confirmed");
    expect(restored.archivedSessionIds).toEqual(["kept"]);
    expect(restored.pinnedSessionIds).toEqual(["kept"]);
    const native = JSON.parse(
      readFileSync(join(f.data, "web-codex", "sessions", "index.json"), "utf8"),
    ).kept.nativeRef;
    expect(native.locator.codexHome).toBe(f.home);
    expect(JSON.parse(readFileSync(join(f.source, "workspaces.json"), "utf8")).items[0].title).toBe(
      "Original",
    );
  });
  it("rejects late configuration conflicts, a second home owner and forged request envelopes", async () => {
    const f = await fixture();
    const configured = await f.post("configure", f.configuration);
    expect(configured.status).toBe(200);
    const reply = configured.body.result as { scope: string };
    const repeated = await f.post("configure", f.configuration);
    expect(repeated.body.result).toEqual(configured.body.result);
    const other = join(f.root, "other-home");
    mkdirSync(other);
    expect(
      (await f.post("configure", { ...f.configuration, home: other })).body.error?.message,
    ).toContain("scope-conflict");
    const second = new SharedWebCodexOwner(
      { ...f.environment, CODEXHOST_DATA_DIR: join(f.root, "another-host") },
      new ClientChannelEvents(),
      async () => false,
      f.preferences,
    );
    cleanup.push(() => second.close());
    await expect(second.configure(f.configuration)).rejects.toThrow("source-owner-live");
    for (const input of [
      { request: { home: other } },
      { nativeRef: { nativeSessionId: "official-id" } },
      { home: other },
      { adapter: "official" },
    ]) {
      const denied = await f.post("request", {
        epoch: f.events.epoch,
        address: { scope: reply.scope },
        operation: "list",
        input,
      });
      expect(denied.body.error).toBeDefined();
    }
    expect(
      (
        await f.post("request", {
          epoch: f.events.epoch,
          address: { scope: `web-codex:${"0".repeat(64)}` },
          operation: "list",
          input: {},
        })
      ).body.error?.message,
    ).toContain("scope-unknown");
    expect(
      (
        await f.post("configure", {
          ...f.configuration,
          home: f.environment.CODEXHOST_GUI_CODEX_HOME,
        })
      ).body.error?.message,
    ).toContain("GUI home overlap");
  });
  it("scopes bounded submission receipts to the complete session address and input", async () => {
    const f = await fixture();
    const reply = (await f.post("configure", f.configuration)).body.result as { scope: string };
    const request = (operation: string, input: Record<string, unknown>, sessionId?: string) =>
      f.post("request", {
        epoch: f.events.epoch,
        address: { scope: reply.scope, ...(sessionId ? { sessionId } : {}) },
        operation,
        input,
      });
    const one = (await request("create", { cwd: f.root })).body.result as { sessionId: string };
    const two = (await request("create", { cwd: f.root })).body.result as { sessionId: string };
    const prompt = {
      requestId: "same-request",
      mode: "queue",
      content: [{ type: "text", text: "receipt test" }],
    };
    expect((await request("prompt", prompt, one.sessionId)).body.result).toEqual({
      accepted: true,
    });
    expect((await request("prompt", prompt, one.sessionId)).body.result).toEqual({
      accepted: true,
    });
    expect((await request("prompt", prompt, two.sessionId)).body.result).toEqual({
      accepted: true,
    });
    expect(
      (
        await request(
          "prompt",
          { ...prompt, content: [{ type: "text", text: "changed" }] },
          one.sessionId,
        )
      ).body.error?.message,
    ).toContain("request-id-conflict");
    // The synthetic Adapter deliberately refuses native execution. Receipt acceptance
    // and one durable user input per address are independently testable without a model.
    for (const id of [one.sessionId, two.sessionId]) {
      const log = readFileSync(join(f.data, "web-codex", "sessions", id, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(log.filter((event) => event.type === "user/message")).toHaveLength(1);
    }
  });
});
