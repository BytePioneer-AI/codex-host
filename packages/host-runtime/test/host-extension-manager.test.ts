import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { HostClientChannel } from "@codexhost/desktop-control";
import {
  DEFAULT_HOST_EXTENSION_STATS_URL,
  installHostExtension,
  updateHostExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  HOST_EXTENSION_CATALOG_MIRROR_URL,
  HOST_EXTENSION_CATALOG_URL,
  HOST_EXTENSIONS_RPC as RPC,
  HOST_EXTENSION_MANAGEMENT_METHODS,
  hostExtensionsRpcSchemas as schemas,
  type HostExtensionManifestV2,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import { AppServerHost } from "../src/app-server-host.js";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { HostExtensionManager } from "../src/host-extension-manager.js";
import { handleHostExtensionRequest } from "../src/host-extension-requests.js";
import { JsonLineCollector, writeRequest } from "./app-server-host-fixture.js";

let root: string;
let dataDir: string;
const cleanup: (() => unknown)[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(await realpath(tmpdir()), "host-extension-test-"));
  dataDir = path.join(root, "host");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await rm(root, { force: true, recursive: true });
});

const backend = (version: string, broken = false) => `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export async function activate(ctx) {
  const pid = process.pid;
  const life = join(ctx.dataDir, 'life.txt');
  appendFileSync(life, ${JSON.stringify(`start ${version} `)} + pid + '\\n');
  ${broken ? "throw new Error('Broken update')" : ""}
  await ctx.readSettings();
  ctx.handle('probe', async (values) => {
    if (values) await ctx.writeSettings(values);
    return { pid, version: ${JSON.stringify(version)}, dataDir: ctx.dataDir, values: await ctx.readSettings() };
  });
  return () => appendFileSync(life, ${JSON.stringify(`stop ${version} `)} + pid + '\\n');
}`;

async function source(
  id: string,
  overrides: Partial<HostExtensionManifestV2>,
  files: Record<string, string | Buffer>,
) {
  const localDir = await mkdtemp(path.join(root, "package-"));
  const manifest = {
    manifestVersion: 2,
    id,
    name: { en: id, "zh-CN": id },
    description: { en: id, "zh-CN": id },
    version: "1",
    ...overrides,
  };
  await writeFile(path.join(localDir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(localDir, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  return { type: "localDir" as const, localDir };
}

async function backendSource(version: string, broken = false) {
  return source(
    "sample",
    {
      version,
      backend: { apiVersion: 1, entry: "worker.mjs" },
      desktop: { apiVersion: 1, script: "desktop.js" },
      page: { apiVersion: 1, entry: "page.mjs" },
      slots: ["sidebar.thread-badge"],
      icon: "icon.png",
    },
    {
      "worker.mjs": backend(version, broken),
      "desktop.js": "define({activate(){}})",
      "page.mjs": "export function mount() {}",
      "icon.png": Buffer.from("89504e470d0a1a0a", "hex"),
    },
  );
}

function startHost({
  manager,
  remote = false,
}: { manager?: HostExtensionManager; remote?: boolean } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const collector = new JsonLineCollector(output);
  const host = new AppServerHost({
    stockCodexPath: "/unused",
    arguments: [],
    externalOnly: true,
    ...(manager ? { hostExtensions: manager } : {}),
    environment: {
      HOME: root,
      CODEX_HOME: path.join(root, ".codex"),
      CODEXHOST_DATA_DIR: dataDir,
      ...(remote ? { CODEXHOST_REMOTE_SSH_MANAGED: "1" } : {}),
    },
    desktopInput: input,
    desktopOutput: output,
    diagnosticOutput: new PassThrough(),
    mappingStore: new MappingStore({
      directory: path.join(root, manager ? "desktop-store" : "host-store"),
    }),
    externalAdapters: new Map(),
  });
  const running = host.run();
  const close = async () => {
    host.close();
    await running;
  };
  cleanup.push(close);
  let next = 0;
  return {
    host,
    close,
    async desktop(method: string, params: JsonObject = {}) {
      const id = ++next;
      writeRequest(input, { id, method, params });
      return collector.waitFor((message) => message.id === id, 5_000);
    },
  };
}

async function connectWeb(host: AppServerHost) {
  const channel = await startClientChannelServer({
    target: host,
    directory: path.join(root, "client-hosts"),
    owner: "service",
    environment: {},
  });
  cleanup.push(() => channel.close());
  const web = new HostClientChannel(path.join(root, "client-hosts"), channel.descriptor);
  cleanup.push(() => web.close());
  await web.start();
  return web;
}

function location(id = "sample") {
  return path.join(dataDir, "host-extension-data", id);
}
const journal = () => readFile(path.join(location(), "life.txt"), "utf8");
function reaped(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
}

it("migrates enabled v1 backends before starting them and diagnoses a broken install", async () => {
  const legacyRoot = path.join(dataDir, "desktop-extensions");
  const sample = path.join(legacyRoot, "sample");
  await mkdir(sample, { recursive: true, mode: 0o700 });
  await mkdir(path.join(legacyRoot, "broken"), { mode: 0o700 });
  await writeFile(
    path.join(sample, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "sample",
      desktopApi: 1,
      name: "Legacy backend",
      version: "1",
      backend: { script: "worker.mjs" },
    }),
  );
  await writeFile(path.join(sample, "worker.mjs"), backend("1"));
  await writeFile(
    path.join(legacyRoot, "enabled.json"),
    JSON.stringify({ version: 1, revision: 1, enabled: ["broken", "sample"] }),
  );
  const diagnostics: string[] = [];
  const manager = new HostExtensionManager(
    dataDir,
    () => undefined,
    (message) => {
      diagnostics.push(message);
    },
  );
  cleanup.push(() => manager.close());

  await manager.start();
  expect(await manager.list()).toMatchObject({
    configuration: { enabled: ["sample"] },
    extensions: [{ id: "sample", state: "valid", enabled: true, backendState: "running" }],
  });
  expect(await journal()).toMatch(/^start 1 \d+\n$/u);
  expect(diagnostics).toEqual([expect.stringContaining('Legacy Desktop extension "broken"')]);
});

it("starts once before any clients connect and shares the process and settings across Desktop and client-channel", async () => {
  const { activationId } = await installHostExtension({
    dataDir,
    source: await backendSource("1"),
  });
  const other = await source(
    "desktop-first",
    { desktop: { apiVersion: 1, script: "desktop.js" }, slots: ["sidebar.thread-badge"] },
    { "desktop.js": "define({activate(){}})" },
  );
  await installHostExtension({ dataDir, source: other });
  await updateHostExtensionConfiguration(dataDir, { id: "desktop-first", action: "enable" });
  await updateHostExtensionConfiguration(dataDir, { id: "sample", action: "enable" });
  const { host, close } = startHost();
  await expect.poll(journal).toMatch(/^start 1 \d+\n$/u);
  const pid = Number((await journal()).trim().split(" ").at(-1));
  assert(host.hostExtensions, "Expected the local Host extension manager");
  const viewer = startHost({ manager: host.hostExtensions });
  const web = await connectWeb(host);
  const events: number[] = [];
  const unsubscribe = web.subscribe((event) => {
    if (event.type === "extensions-changed") events.push(event.revision);
  });
  cleanup.push(unsubscribe);
  const probe = { id: "sample", activationId, method: "probe" };
  expect(
    await viewer.desktop(RPC.backendInvoke, { ...probe, params: { from: "desktop" } }),
  ).toMatchObject({
    result: { result: { pid, dataDir: location(), values: { from: "desktop" } } },
  });
  expect(await web.request(RPC.backendInvoke, probe)).toMatchObject({
    result: { pid, values: { from: "desktop" } },
  });
  expect(
    await web.request(RPC.settingsSet, {
      id: "sample",
      activationId,
      expectedSettingsRevision: 1,
      values: { from: "web" },
    }),
  ).toEqual({ settingsRevision: 2, values: { from: "web" } });
  expect(await viewer.desktop(RPC.settingsGet, { id: "sample", activationId })).toMatchObject({
    result: { settingsRevision: 2, values: { from: "web" } },
  });
  expect(JSON.parse(await readFile(path.join(location(), "settings.json"), "utf8"))).toEqual({
    settingsRevision: 2,
    values: { from: "web" },
  });
  expect(await web.request(RPC.snapshot, {})).toMatchObject({
    revision: 2,
    extensions: expect.arrayContaining([
      expect.objectContaining({
        id: "sample",
        settingsRevision: 2,
        desktopConflictWith: "desktop-first",
      }),
    ]),
  });
  await expect.poll(() => events).toEqual([1, 2]);
  await viewer.close();
  expect(await web.request(RPC.backendInvoke, probe)).toMatchObject({
    result: { pid, values: { from: "web" } },
  });
  web.close();
  expect(await journal()).toBe(`start 1 ${pid}\n`);
  await close();
  expect(await journal()).toBe(`start 1 ${pid}\nstop 1 ${pid}\n`);
  reaped(pid);
});

it("installs and enables web-, desktop-, and page-only plugins without spawning a child", async () => {
  const { host } = startHost();
  const web = await connectWeb(host);
  for (const [expectedRevision, target] of (["web", "desktop", "page"] as const).entries()) {
    const entry = target === "desktop" ? "index.js" : "index.mjs";
    const plugin = await source(
      target,
      { [target]: { apiVersion: 1, [target === "desktop" ? "script" : "entry"]: entry } },
      { [entry]: "throw new Error('Do not run frontend in the Host')" },
    );
    await web.request(RPC.install, { source: plugin });
    await web.request(RPC.enable, { id: target, expectedRevision });
    await expect(readFile(path.join(location(target), "life.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  expect(await web.request(RPC.list, {})).toMatchObject({
    extensions: ["desktop", "page", "web"].map((id) => ({
      id,
      enabled: true,
      backendState: "none",
    })),
  });
  expect(await web.request(RPC.snapshot, {})).toMatchObject({
    revision: 6,
    extensions: ["desktop", "page", "web"].map((id) => ({ id, settingsRevision: 0 })),
  });
});

it("reaps old generations on update, rollback, disable, recover and uninstall", async () => {
  const { host } = startHost();
  const web = await connectWeb(host);
  const install = async () =>
    schemas[RPC.install].result.parse(
      await web.request(RPC.install, { source: await backendSource("1") }),
    );
  const first = await install();
  await web.request(RPC.enable, { id: "sample", expectedRevision: 0 });
  const probe = async (activationId: string, version: string) => {
    const reply = await web.request<{ result: { pid: number; version: string } }>(
      RPC.backendInvoke,
      { id: "sample", activationId, method: "probe" },
    );
    expect(reply.result.version).toBe(version);
    return reply.result.pid;
  };
  const pid1 = await probe(first.activationId, "1");
  const update = async (
    current: { activationId: string; digest: string },
    version: string,
    broken = false,
  ) =>
    web.request(RPC.update, {
      id: "sample",
      expectedActivationId: current.activationId,
      expectedDigest: current.digest,
      source: await backendSource(version, broken),
    });
  const second = schemas[RPC.update].result.parse(await update(first, "2"));
  reaped(pid1);
  const pid2 = await probe(second.activationId, "2");
  await expect(probe(first.activationId, "1")).rejects.toMatchObject({ code: -32009 });
  await expect(update(second, "broken", true)).rejects.toMatchObject({ code: -32000 });
  reaped(pid2);
  const {
    extensions: [restored],
  } = schemas[RPC.snapshot].result.parse(await web.request(RPC.snapshot, {}));
  assert(restored, "Expected the restored extension in the snapshot");
  expect(restored).toMatchObject({
    digest: second.digest,
    activationId: expect.not.stringMatching(second.activationId),
  });
  const rolledBack = await probe(restored.activationId, "2");
  const log = await journal();
  const brokenPid = Number(log.match(/start broken (\d+)/u)?.[1]);
  reaped(brokenPid);
  expect(log).toBe(
    `start 1 ${pid1}\nstop 1 ${pid1}\nstart 2 ${pid2}\nstop 2 ${pid2}\nstart broken ${brokenPid}\nstart 2 ${rolledBack}\n`,
  );
  await web.request(RPC.disable, { id: "sample", expectedRevision: 1 });
  reaped(rolledBack);
  await expect(probe(restored.activationId, "2")).rejects.toMatchObject({ code: -32000 });
  await web.request(RPC.enable, { id: "sample", expectedRevision: 2 });
  const beforeRecover = await probe(restored.activationId, "2");
  expect(await web.request(RPC.recover, { expectedRevision: 2 })).toEqual({
    state: "revision-conflict",
    revision: 3,
  });
  await web.request(RPC.recover, {});
  reaped(beforeRecover);
  await web.request(RPC.enable, { id: "sample", expectedRevision: 4 });
  const beforeUninstall = await probe(restored.activationId, "2");
  expect(await web.request(RPC.uninstall, { id: "sample" })).toEqual({
    id: "sample",
    removed: true,
  });
  reaped(beforeUninstall);
  expect(await web.request(RPC.snapshot, {})).toMatchObject({ extensions: [] });
});

it("rejects all unified RPCs on SSH-managed Hosts and restricts asset reads to valid frontend resources", async () => {
  const remote = startHost({ remote: true });
  for (const method of HOST_EXTENSION_MANAGEMENT_METHODS) {
    expect(await remote.host.handleClientRequest(method, {})).toMatchObject({
      error: { code: -32601 },
    });
    expect(await remote.desktop(method)).toMatchObject({ error: { code: -32601 } });
  }
  await remote.close();
  const { host } = startHost();
  const web = await connectWeb(host);
  await expect(
    web.request(RPC.install, {
      source: { type: "zip", localZipPath: path.join(root, "package.zip") },
    }),
  ).rejects.toMatchObject({ code: -32602 });
  const { id, digest, activationId } = schemas[RPC.install].result.parse(
    await web.request(RPC.install, { source: await backendSource("1") }),
  );
  const asset = (path: string, expected = activationId) =>
    web.request(RPC.asset, { id, activationId: expected, digest, path });
  expect(await asset("icon.png")).toMatchObject({ mimeType: "image/png", digest });
  await expect(asset("page.mjs")).rejects.toMatchObject({ code: -32000 });
  await web.request(RPC.enable, { id, expectedRevision: 0 });
  expect(await asset("page.mjs")).toMatchObject({ mimeType: "text/javascript", digest });
  await expect(asset("worker.mjs")).rejects.toMatchObject({ code: -32000 });
  await expect(asset("../worker.mjs")).rejects.toMatchObject({ code: -32602 });
  await expect(asset("page.mjs", "e3472f62-d37b-46e4-9a56-b421680b920c")).rejects.toMatchObject({
    code: -32009,
  });
});

it("reports download stats asynchronously for catalog install and update only", async () => {
  const buildArchive = (version: string) =>
    makeZip([
      {
        name: "pkg/manifest.json",
        data: JSON.stringify({
          manifestVersion: 2,
          id: "focus-sample",
          version,
          name: { en: "Focus Sample", "zh-CN": "专注示例" },
          description: { en: "Sample", "zh-CN": "示例" },
          page: { apiVersion: 1, entry: "page.mjs" },
        }),
      },
      { name: "pkg/page.mjs", data: "export function mount() {}" },
    ]);

  let currentVersion = "1.0.0";
  const archives: Record<string, Buffer> = {
    "1.0.0": buildArchive("1.0.0"),
    "1.1.0": buildArchive("1.1.0"),
  };
  const statsCalls: Array<{ url: string; method: string | undefined }> = [];

  vi.stubEnv("CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL", undefined);
  vi.stubEnv("CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL", undefined);
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const href = String(input);
    if (href.startsWith(`${DEFAULT_HOST_EXTENSION_STATS_URL}/install/`)) {
      statsCalls.push({ url: href, method: init?.method });
      // Verify a stats failure never fails or blocks the install/update.
      return new Response(null, { status: 503 });
    }
    const zip = archives[currentVersion];
    if (!zip) {
      throw new Error(`Missing test archive for ${currentVersion}`);
    }
    const downloadUrl = `https://github.com/BytePioneer-AI/focus-sample/releases/download/v${currentVersion}/focus-sample.zip`;
    if (href === HOST_EXTENSION_CATALOG_URL || href === HOST_EXTENSION_CATALOG_MIRROR_URL) {
      return Response.json({
        schemaVersion: 2,
        generatedAt: `2026-11-23T00:00:0${currentVersion === "1.0.0" ? "0" : "1"}Z`,
        extensions: [
          {
            id: "focus-sample",
            version: currentVersion,
            format: "codexhost",
            targets: ["desktop", "web"],
            apis: { page: 1 },
            name: { en: "Focus Sample", "zh-CN": "专注示例" },
            description: { en: "Sample", "zh-CN": "示例" },
            author: "BytePioneer-AI",
            repository: "https://github.com/BytePioneer-AI/focus-sample",
            downloadUrl,
            sha256: createHash("sha256").update(zip).digest("hex"),
          },
        ],
      });
    }
    if (href === downloadUrl) return new Response(Uint8Array.from(zip));
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const manager = new HostExtensionManager(dataDir, () => undefined);
  cleanup.push(() => manager.close());

  const installed = await manager.install({ source: { type: "catalog", id: "focus-sample" } });
  await vi.waitFor(() =>
    expect(statsCalls).toEqual([
      { url: `${DEFAULT_HOST_EXTENSION_STATS_URL}/install/focus-sample`, method: "POST" },
    ]),
  );

  currentVersion = "1.1.0";
  await manager.update({
    id: "focus-sample",
    expectedDigest: installed.digest,
    expectedActivationId: installed.activationId,
  });
  await vi.waitFor(() => expect(statsCalls).toHaveLength(2));

  await manager.install({
    source: await source(
      "local-only",
      { page: { apiVersion: 1, entry: "page.mjs" } },
      { "page.mjs": "export function mount() {}" },
    ),
  });
  expect(statsCalls).toHaveLength(2);
});

it("downloads extensions concurrently without blocking other operations, logs causes, and surfaces safe errors", async () => {
  const buildArchive = (id: string, version: string) =>
    makeZip([
      {
        name: "pkg/manifest.json",
        data: JSON.stringify({
          manifestVersion: 2,
          id,
          version,
          name: { en: id, "zh-CN": id },
          description: { en: id, "zh-CN": id },
          page: { apiVersion: 1, entry: "page.mjs" },
        }),
      },
      { name: "pkg/page.mjs", data: "export function mount() {}" },
    ]);

  const slowZip = buildArchive("slow-ext", "1.0.0");
  const fastZip = buildArchive("fast-ext", "1.0.0");
  const brokenZip = buildArchive("broken-ext", "1.0.0");
  const slowUrl = "https://github.com/BytePioneer-AI/slow-ext/releases/download/v1.0.0/slow.zip";
  const fastUrl = "https://github.com/BytePioneer-AI/fast-ext/releases/download/v1.0.0/fast.zip";
  const brokenUrl =
    "https://github.com/BytePioneer-AI/broken-ext/releases/download/v1.0.0/broken.zip";

  const slowStarted = Promise.withResolvers<undefined>();
  const releaseSlow = Promise.withResolvers<undefined>();
  let slowAborted = false;

  vi.stubEnv("CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL", "off");
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const href = String(input);
    if (href === HOST_EXTENSION_CATALOG_URL || href === HOST_EXTENSION_CATALOG_MIRROR_URL) {
      return Response.json({
        schemaVersion: 2,
        generatedAt: "2026-11-25T10:30:00.000Z",
        extensions: [
          {
            id: "slow-ext",
            version: "1.0.0",
            format: "codexhost",
            targets: ["desktop", "web"],
            apis: { page: 1 },
            name: { en: "Slow", "zh-CN": "慢速" },
            description: { en: "Slow", "zh-CN": "慢速" },
            author: "BytePioneer-AI",
            repository: "https://github.com/BytePioneer-AI/slow-ext",
            downloadUrl: slowUrl,
            sha256: createHash("sha256").update(slowZip).digest("hex"),
          },
          {
            id: "fast-ext",
            version: "1.0.0",
            format: "codexhost",
            targets: ["desktop", "web"],
            apis: { page: 1 },
            name: { en: "Fast", "zh-CN": "快速" },
            description: { en: "Fast", "zh-CN": "快速" },
            author: "BytePioneer-AI",
            repository: "https://github.com/BytePioneer-AI/fast-ext",
            downloadUrl: fastUrl,
            sha256: createHash("sha256").update(fastZip).digest("hex"),
          },
          {
            id: "broken-ext",
            version: "1.0.0",
            format: "codexhost",
            targets: ["desktop", "web"],
            apis: { page: 1 },
            name: { en: "Broken", "zh-CN": "损坏" },
            description: { en: "Broken", "zh-CN": "损坏" },
            author: "BytePioneer-AI",
            repository: "https://github.com/BytePioneer-AI/broken-ext",
            downloadUrl: brokenUrl,
            sha256: createHash("sha256").update(brokenZip).digest("hex"),
          },
        ],
      });
    }
    if (href === slowUrl) {
      slowStarted.resolve(undefined);
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            slowAborted = true;
            reject(init.signal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
        void releaseSlow.promise.then(() => resolve());
      });
      return new Response(Uint8Array.from(slowZip));
    }
    if (href === fastUrl) return new Response(Uint8Array.from(fastZip));
    if (href === brokenUrl) return new Response(null, { status: 404 });
    throw new Error(`Unexpected fetch: ${href}`);
  });

  const diagnostics: string[] = [];
  const manager = new HostExtensionManager(
    dataDir,
    () => undefined,
    (message) => {
      diagnostics.push(message);
    },
  );
  cleanup.push(() => manager.close());

  // Start slow-ext download and hold it in flight.
  const slowInstall = handleHostExtensionRequest(manager, RPC.install, {
    source: { type: "catalog", id: "slow-ext" },
  });
  await slowStarted.promise;

  // fast-ext installs and enables immediately while slow-ext is still downloading.
  const fastReply = await handleHostExtensionRequest(manager, RPC.install, {
    source: { type: "catalog", id: "fast-ext" },
  });
  expect(fastReply).toMatchObject({ result: { id: "fast-ext", replaced: false } });
  const enabledReply = await handleHostExtensionRequest(manager, RPC.enable, {
    id: "fast-ext",
    expectedRevision: 0,
  });
  expect(enabledReply).toMatchObject({
    result: { state: "saved", configuration: { enabled: ["fast-ext"] } },
  });

  // Safe HTTP error surfaces directly to caller and writes a diagnostic log entry.
  const failedReply = await handleHostExtensionRequest(manager, RPC.install, {
    source: { type: "catalog", id: "broken-ext" },
  });
  expect(failedReply).toEqual({
    error: { code: -32000, message: "Download returned HTTP 404" },
  });
  expect(diagnostics).toContainEqual(
    expect.stringContaining(
      "Host extension codexhost/extensions/install failed: Download returned HTTP 404",
    ),
  );

  // Release slow-ext and verify both extensions are installed.
  releaseSlow.resolve(undefined);
  expect(await slowInstall).toMatchObject({ result: { id: "slow-ext", replaced: false } });

  // Raw internal/FS errors never leak host paths to RPC callers, while diagnostics log them.
  const missingLocal = await handleHostExtensionRequest(manager, RPC.install, {
    source: { type: "localDir", localDir: path.join(root, "does-not-exist-secret-dir") },
  });
  expect(missingLocal).toEqual({
    error: {
      code: -32000,
      message: "Host extension operation failed: codexhost/extensions/install",
    },
  });
  expect(diagnostics).toContainEqual(expect.stringContaining("does-not-exist-secret-dir"));

  // Closing the manager aborts any in-flight download cleanly and rejects concurrent calls without deadlocking.
  const secondSlowStarted = Promise.withResolvers<undefined>();
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const href = String(input);
    if (href === HOST_EXTENSION_CATALOG_URL || href === HOST_EXTENSION_CATALOG_MIRROR_URL) {
      return Response.json({
        schemaVersion: 2,
        generatedAt: "2026-11-25T10:31:00.000Z",
        extensions: [
          {
            id: "slow-ext",
            version: "1.0.0",
            format: "codexhost",
            targets: ["desktop", "web"],
            apis: { page: 1 },
            name: { en: "Slow", "zh-CN": "慢速" },
            description: { en: "Slow", "zh-CN": "慢速" },
            author: "BytePioneer-AI",
            repository: "https://github.com/BytePioneer-AI/slow-ext",
            downloadUrl: slowUrl,
            sha256: createHash("sha256").update(slowZip).digest("hex"),
          },
        ],
      });
    }
    if (href === slowUrl) {
      secondSlowStarted.resolve(undefined);
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            slowAborted = true;
            reject(init.signal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  });
  const currentSlow = (await manager.list()).extensions.find((e) => e.id === "slow-ext");
  assert(currentSlow?.state === "valid");
  const abortedUpdate = handleHostExtensionRequest(manager, RPC.update, {
    id: "slow-ext",
    expectedDigest: currentSlow.digest,
    expectedActivationId: currentSlow.activationId,
    source: { type: "catalog", id: "slow-ext" },
  });
  await secondSlowStarted.promise;
  const closingPromise = manager.close();
  // Concurrent install arriving during close() must reject immediately instead of deadlocking close().
  const duringClose = handleHostExtensionRequest(manager, RPC.install, {
    source: { type: "catalog", id: "fast-ext" },
  });
  await closingPromise;
  expect(slowAborted).toBe(true);
  expect(await abortedUpdate).toMatchObject({
    error: { code: -32000, message: "Download aborted" },
  });
  expect(await duringClose).toEqual({
    error: { code: -32000, message: "Host extensions are closing" },
  });
  const entriesAfterClose = await readdir(path.join(dataDir, "host-extensions"));
  expect(entriesAfterClose.filter((name) => name.startsWith(".staging-"))).toEqual([]);
});
