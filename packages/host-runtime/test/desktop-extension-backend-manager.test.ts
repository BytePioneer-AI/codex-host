import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  desktopExtensionsRoot,
  installFromZipBuffer,
  readDesktopExtensionSettings,
  writeDesktopExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import { afterEach, beforeEach, expect, it } from "vitest";
import { extensionZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import { DesktopExtensionBackendManager } from "../src/desktop-extension-backend-manager.js";

let dataDir: string;
let root: string;
let manager: DesktopExtensionBackendManager;
let diagnostics: string[];
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "desktop-backend-"));
  root = desktopExtensionsRoot(dataDir);
  diagnostics = [];
  manager = new DesktopExtensionBackendManager(dataDir, (message) => diagnostics.push(message));
});
afterEach(async () => {
  await manager.close();
  await rm(dataDir, { recursive: true, force: true });
});

const install = (id: string, source: string, slots?: string[]) =>
  installFromZipBuffer({
    extensionsRoot: root,
    zipBuffer: extensionZip({
      id,
      manifest: { slots, desktop: undefined, backend: { script: "backend.mjs" } },
      extras: [{ name: "backend.mjs", data: source }],
    }),
  });
const select = (enabled: string[]) =>
  writeDesktopExtensionConfiguration(root, undefined, () => ({ enabled }));

it("activates the startup selection, reloads changed entries and disposes after a separate config writer disables it", async () => {
  const read = () => readDesktopExtensionSettings({ dataDir, id: "sample" });
  const { installedPath } = await install(
    "sample",
    `
    export async function activate(ctx) {
      await ctx.writeSettings({ value: 'activated' });
      ctx.handle('info', params => ({ id: ctx.extensionId, dataDir: ctx.dataDir, dir: ctx.extensionDir, params }));
      return async () => { await ctx.writeSettings({ value: 'disposed' }); };
    }`,
  );
  await select(["sample"]);
  manager.start();
  // Observe activation rather than triggering it by invoking an RPC.
  await expect.poll(read, { timeout: 3_000 }).toEqual({ value: "activated" });
  expect(await manager.invoke("sample", "info", [42])).toEqual({
    id: "sample",
    dataDir: path.join(installedPath, "..", "..", "desktop-extension-data", "sample"),
    dir: installedPath,
    params: [42],
  });
  await expect(manager.invoke("sample", "unregistered")).rejects.toThrow("not registered");
  await writeFile(
    path.join(installedPath, "backend.mjs"),
    `
    export default { async activate(ctx) {
      const previous = await ctx.readSettings();
      ctx.handle('info', () => previous);
      return { async dispose() { await ctx.writeSettings({ value: 'updated backend disposed' }); } };
    } }`,
  );
  await manager.reconcile();
  expect(await manager.invoke("sample", "info")).toEqual({ value: "disposed" });
  await select([]);
  await expect.poll(read, { timeout: 3_000 }).toEqual({ value: "updated backend disposed" });
  await expect(manager.invoke("sample", "info")).rejects.toThrow("not active");
});

it("isolates activation, handler, disposal and uncaught async errors from the Host and other backends", async () => {
  await install(
    "bad",
    `export function activate(ctx) {
    ctx.handle('ping', () => false);
    throw new Error('activate failed');
  }`,
  );
  await install(
    "crash",
    `export function activate(ctx) {
    ctx.handle('crash', () => { queueMicrotask(() => { throw new Error('async failure'); }); return new Promise(() => {}); });
  }`,
  );
  await install(
    "good",
    `export function activate(ctx) {
    ctx.handle('reject', async () => { throw new Error('handler failed'); });
    ctx.handle('ping', () => true);
    return () => { throw new Error('dispose failed'); };
  }`,
  );
  await install("conflict", `export function activate(ctx) { ctx.handle('ping', () => false); }`, [
    "appearance.theme",
  ]);
  await install("skin", `export function activate() {}`, ["appearance.theme"]);
  await select(["bad", "crash", "good", "skin", "conflict"]);
  await manager.reconcile();
  expect(diagnostics).toContainEqual(expect.stringContaining("activate failed"));
  await expect(manager.invoke("bad", "ping")).rejects.toThrow("not active");
  await expect(manager.invoke("conflict", "ping")).rejects.toThrow("not active");
  await expect(manager.invoke("crash", "crash")).rejects.toThrow("Backend exited");
  await expect(manager.invoke("good", "reject")).rejects.toThrow("handler failed");
  expect(await manager.invoke("good", "ping")).toBe(true);
  await select(["conflict"]);
  await manager.reconcile();
  expect(diagnostics).toContainEqual(expect.stringContaining("dispose failed"));
  expect(await manager.invoke("conflict", "ping")).toBe(false);
});

it("rejects over-limit or invalid IPC without interrupting either backend", async () => {
  await install(
    "sample",
    `export function activate(ctx) {
      ctx.handle('large', () => 'é'.repeat(1024 * 1024));
      ctx.handle('circular', () => { const value = {}; value.self = value; return value; });
      ctx.handle('settings-write', () => ctx.writeSettings({ value: 'é'.repeat(1024 * 1024) }));
      ctx.handle('settings-burst', async () => {
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => ctx.readSettings()));
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length !== 1) throw new Error('Expected exactly one rejected settings request');
        throw failures[0].reason;
      });
      ctx.handle('settings', () => ctx.writeSettings({ ready: true }));
    }`,
  );
  await install("other", `export function activate(ctx) { ctx.handle('ping', () => 'pong'); }`);
  await select(["sample", "other"]);
  await manager.reconcile();

  for (const [method, reason] of [
    ["large", "Backend IPC message exceeds 2 MiB"],
    ["circular", "Backend IPC message is not JSON-serializable"],
    ["settings-write", "Backend IPC message exceeds 2 MiB"],
    ["settings-burst", "Too many pending backend settings requests (limit: 4)"],
  ] as const) {
    await expect(manager.invoke("sample", method)).rejects.toThrow(reason);
    await expect(manager.invoke("other", "ping")).resolves.toBe("pong");
  }
  await expect(manager.invoke("sample", "settings")).resolves.toEqual({ ready: true });
  expect(diagnostics).toEqual([]);
});

it("rejects an oversized invoke before the backend handler runs", async () => {
  await install(
    "sample",
    `export function activate(ctx) {
      let calls = 0;
      ctx.handle('count', () => ++calls);
    }`,
  );
  await select(["sample"]);
  await manager.reconcile();
  await expect(manager.invoke("sample", "count", "é".repeat(1024 * 1024))).rejects.toThrow(
    "Backend IPC message exceeds 2 MiB",
  );
  await expect(manager.invoke("sample", "count")).resolves.toBe(1);
});

it("does not load a script that changes after the scan and rescans on the next invocation", async () => {
  const settings = () => readDesktopExtensionSettings({ dataDir, id: "sample" });
  const finalSource = `export async function activate(ctx) {
    await ctx.writeSettings({ loaded: 'final' });
    ctx.handle('version', () => 'final');
  }`;
  const { installedPath } = await install(
    "sample",
    `import { writeFile } from 'node:fs/promises';
    export function activate(ctx) {
      ctx.handle('version', () => 'original');
      return async () => writeFile(new URL(import.meta.url), ${JSON.stringify(finalSource)});
    }`,
  );
  await select(["sample"]);
  await manager.reconcile();
  await expect(manager.invoke("sample", "version")).resolves.toBe("original");
  await writeFile(path.join(installedPath, "backend.mjs"), "export function activate() {};");
  // Disposal replaces the scanned entry before the next backend loads it.
  await manager.reconcile();
  expect(await settings()).toEqual({});
  await expect(manager.invoke("sample", "version")).resolves.toBe("final");
  expect(await settings()).toEqual({ loaded: "final" });
});
