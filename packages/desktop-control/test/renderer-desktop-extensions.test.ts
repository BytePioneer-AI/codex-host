import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  desktopExtensionsStatusPath,
  installFromZipBuffer,
  uninstallDesktopExtension,
  writeDesktopExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import {
  desktopExtensionsDiagnosticSchema,
  type DesktopExtensionStatus,
} from "@codexhost/shared-contracts";
import { extensionZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import { RendererDesktopExtensions } from "../src/renderer-desktop-extensions.js";
import { createRendererCdpControlSession } from "../src/renderer-cdp-control-session.js";

let directory: string;
let root: string;
const controllers: RendererDesktopExtensions[] = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "extension-controller-"));
  root = path.join(directory, "desktop-extensions");
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.close();
  await rm(directory, { recursive: true, force: true });
});

async function install(id: string, script: string) {
  const folder = path.join(root, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(folder, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: { en: `Extension ${id}`, "zh-CN": `扩展 ${id}` },
      categories: ["interface", "workflow"],
      version: "1",
      desktopApi: 1,
      desktop: { script: "desktop.js" },
      slots: [],
    }),
  );
  await writeFile(path.join(folder, "desktop.js"), script);
}

function fakeRenderer(initial: Record<string, DesktopExtensionStatus> = {}) {
  let state = initial;
  const pages = new Map<string, string>();
  let nextScript = 0;
  const events: string[] = [];
  let reloads = 0;
  const evaluations: string[] = [];
  const largest = { entries: 0 };
  const window = {
    __codexhostDesktopExtensionsV1: {
      status: () => state,
      reconcile(entries: Array<{ id: string; hash: string; error?: string }>) {
        state = Object.fromEntries(
          entries.map(({ id, hash, error }) => [
            id,
            { hash, state: error ? "failed" : "running", ...(error ? { error } : {}) },
          ]),
        );
      },
    },
    get top() {
      return window;
    },
  };
  const context = { window, location: new URL("app://-/index.html") };
  const reset = () => {
    state = {};
    for (const script of pages.values()) runInNewContext(script, context);
  };
  return {
    failBindingRead: false,
    failLiveApply: false,
    pages,
    events,
    evaluations,
    largest,
    get state() {
      return state;
    },
    get reloads() {
      return reloads;
    },
    reset,
    on() {
      return () => undefined;
    },
    close() {
      events.push("close");
      pages.clear();
    },
    async evaluate<T>(expression: string): Promise<T> {
      evaluations.push(expression);
      events.push(expression.includes(".status()") ? "status" : "live");
      if (expression.includes("RendererBindingProbe")) {
        if (this.failBindingRead) throw new Error("Binding unavailable");
        return {
          version: 2,
          enabledAgents: ["codex"],
          adapter: { state: "ready", reason: "ready" },
        } as T;
      }
      if (this.failLiveApply && expression.includes(".reconcile("))
        throw new Error("Live reconciliation unavailable");
      return runInNewContext(expression, context) as T;
    },
    async command(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        const source = String(params?.source);
        if (source === "core" || source.includes("__codexhostControllerBundleHash"))
          return { identifier: "core" };
        events.push("add");
        const id = `ext-${++nextScript}`;
        pages.set(id, source);
        largest.entries = Math.max(largest.entries, pages.size);
        return { identifier: id };
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        events.push("remove");
        if (!pages.delete(String(params?.identifier)))
          throw new Error("Unknown snapshot identifier");
      }
      if (method === "Page.reload") {
        events.push("reload");
        reloads++;
        reset();
      }
      return {};
    },
  };
}

it("observes package replacements and uninstalls without polling or reloading Desktop", async () => {
  await installFromZipBuffer({ extensionsRoot: root, zipBuffer: extensionZip() });
  await writeDesktopExtensionConfiguration(root, 1, () => ({ enabled: ["sample"] }));
  const target = fakeRenderer();
  const extensions = controller();
  extensions.attach("target", target);
  await extensions.refresh();
  const original = target.state.sample;
  expect(original).toMatchObject({ state: "running", hash: expect.any(String) });
  const originalHash = original?.hash;
  if (!originalHash) throw new Error("Extension is not running");
  await installFromZipBuffer({
    extensionsRoot: root,
    zipBuffer: extensionZip({ version: "2.0.0" }),
  });
  await expect
    .poll(() => target.state.sample)
    .toMatchObject({ state: "running", hash: expect.not.stringMatching(originalHash) });
  await uninstallDesktopExtension({ dataDir: directory, id: "sample" });
  await expect.poll(() => target.state).toEqual({});
  expect(target.pages.size).toBe(0);
  expect(target.reloads).toBe(0);
});

it("never injects a backend-only package into the renderer snapshot", async () => {
  await install("badge", "define({activate(){}})");
  await installFromZipBuffer({
    extensionsRoot: root,
    zipBuffer: extensionZip({
      manifest: { desktop: undefined, backend: { script: "backend.mjs" } },
      extras: [{ name: "backend.mjs", data: "export function activate() {}" }],
    }),
  });
  await writeDesktopExtensionConfiguration(root, 1, () => ({ enabled: ["badge", "sample"] }));
  const renderer = fakeRenderer();
  const extensions = controller();
  extensions.attach("target", renderer);
  await extensions.refresh();
  expect(Object.keys(renderer.state)).toEqual(["badge"]);
});

function controller() {
  const result = new RendererDesktopExtensions(directory, (error) => {
    throw error;
  });
  controllers.push(result);
  return result;
}

it("replaces the one future snapshot before live apply and avoids resending unchanged entries", async () => {
  await install("tree", "/* tree-v1 */ define({activate(){}})");
  await install("badge", "/* badge-v1 */ define({activate(){}})");
  await writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["tree", "badge"] }));
  const c = controller();
  const renderer = fakeRenderer();
  c.attach("first", renderer);
  await c.refresh();
  expect(renderer.events.slice(0, 3)).toEqual(["status", "add", "live"]);
  const first = [...renderer.pages.keys()];
  renderer.events.length = 0;
  await c.refresh();
  expect([...renderer.pages.keys()]).toEqual(first);
  expect(renderer.events).not.toContain("live");
  await install("tree", "/* tree-v2 */ define({activate(){}})");
  renderer.events.length = 0;
  await c.refresh();
  expect(renderer.events).toEqual(["status", "remove", "add", "live", "status"]);
  expect(renderer.largest.entries).toBe(1);
  expect([...renderer.pages.keys()]).not.toEqual(first);
  const live = renderer.evaluations.findLast((source) => source.includes("tree-v2"));
  expect(live).not.toContain("badge-v1");
  renderer.reset();
  expect(renderer.state).toMatchObject({ tree: { state: "running" }, badge: { state: "running" } });
  await writeFile(path.join(root, "enabled.json"), "bad json");
  await c.refresh();
  expect(renderer.pages.size).toBe(0);
  expect(renderer.state).toEqual({});
});

it.each(["same", "new"])(
  "replaces a CDP session on the %s target before retiring its snapshot",
  async (kind) => {
    await install("tree", "define({activate(){}})");
    await writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["tree"] }));
    const c = controller();
    const old = fakeRenderer();
    const next = fakeRenderer();
    let target = "old";
    const session = await createRendererCdpControlSession({
      rendererSource: "core",
      rendererCdpEndpoint: "unused",
      timeoutMs: 100,
      desktopExtensions: c,
      operations: {
        listTargets: async () => [
          {
            id: target,
            type: "page",
            title: "Codex",
            url: "app://-/index.html",
            webSocketDebuggerUrl: target,
          },
        ],
        connect: async () => (old.state.tree ? next : old),
        installDraftPrewarmPolicy: async (renderer) => {
          if (renderer === next) expect(old.pages.size).toBe(1);
          return { state: "ready", reason: "owned-request-bridge" };
        },
      },
    });
    try {
      await c.refresh();
      expect(old.state).toHaveProperty("tree");
      if (kind === "same") old.failBindingRead = true;
      else target = "new";
      await session.ensureInstalled();
      await c.refresh();
      expect(old.events.slice(-2)).toEqual(["remove", "close"]);
      expect(old.pages.size).toBe(0);
      expect(next.pages.size).toBe(1);
      expect(next.state).toHaveProperty("tree");
    } finally {
      session.close();
    }
  },
);

it("records a superseded recovery token even if the newer enabled selection cannot be applied", async () => {
  await install("badge", "define({activate(){}})");
  const failures: unknown[] = [];
  const c = new RendererDesktopExtensions(directory, (error) => failures.push(error));
  controllers.push(c);
  const renderer = fakeRenderer();
  c.attach("target", renderer);
  await c.refresh();
  const reloadToken = "e3472f62-d37b-46e4-9a56-b421680b920c";
  await writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["badge"], reloadToken }));
  renderer.failLiveApply = true;
  await c.refresh();
  expect(failures).toEqual([new Error("Live reconciliation unavailable")]);
  const doc = desktopExtensionsDiagnosticSchema.parse(
    JSON.parse(await readFile(desktopExtensionsStatusPath(directory), "utf8")),
  );
  expect(doc.handledReloadToken).toBe(reloadToken);
  renderer.failLiveApply = false;
  await writeDesktopExtensionConfiguration(root, 1, () => ({ enabled: [] }));
  await c.refresh();
  expect(renderer.reloads).toBe(0);
  expect(renderer.state).toEqual({});
});

it("resends the script when the registered hash matches but its state is failed", async () => {
  const script = "/* badge body */ define({activate(){}})";
  await install("badge", script);
  await writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["badge"] }));
  const c = controller();
  const renderer = fakeRenderer();
  c.attach("target", renderer);
  await c.refresh();
  renderer.state.badge = { ...renderer.state.badge, state: "failed" };
  renderer.evaluations.length = 0;
  await c.refresh();
  expect(renderer.evaluations.some((expression) => expression.includes(script))).toBe(true);
});

it("leaves offline reloads extension-free and reconnects from the latest selection", async () => {
  await install("tree", "define({activate(){}})");
  await install("badge", "define({activate(){}})");
  await writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["tree", "badge"] }));
  const online = controller();
  const old = fakeRenderer();
  online.attach("target", old);
  await online.refresh();
  expect(Object.keys(old.state)).toEqual(["tree", "badge"]);
  online.close();
  old.close();
  await writeDesktopExtensionConfiguration(root, 1, () => ({ enabled: ["badge"] }));
  old.reset();
  expect(old.state).toEqual({});
  const reconnected = controller();
  const active = fakeRenderer(old.state);
  reconnected.attach("target", active);
  await reconnected.refresh();
  expect(Object.keys(active.state)).toEqual(["badge"]);
});

it("reads before injecting on restart and persists completed recovery tokens across Controllers", async () => {
  await install("tree", "define({activate(){}})");
  await writeDesktopExtensionConfiguration(root, 0, () => ({ enabled: ["tree"] }));
  const first = controller();
  const old = fakeRenderer();
  first.attach("target", old);
  await first.refresh();
  first.close();
  const second = controller();
  const active = fakeRenderer(old.state);
  second.attach("target", active);
  await second.refresh();
  expect(active.events[0]).toBe("status");
  expect(active.pages.size).toBe(1);
  expect(active.events).not.toContain("live");
  const reloadToken = "e3472f62-d37b-46e4-9a56-b421680b920c";
  await writeDesktopExtensionConfiguration(root, 1, () => ({ enabled: [], reloadToken }));
  await second.refresh();
  await second.refresh();
  expect(active.events.slice(-6)).toContain("reload");
  expect(active.reloads).toBe(1);
  expect(active.pages.size).toBe(0);
  const doc = desktopExtensionsDiagnosticSchema.parse(
    JSON.parse(await readFile(desktopExtensionsStatusPath(directory), "utf8")),
  );
  expect(doc.handledReloadToken).toBe(reloadToken);
  second.close();
  const third = controller();
  const recovered = fakeRenderer();
  third.attach("target", recovered);
  await third.refresh();
  expect(recovered.reloads).toBe(0);
});
