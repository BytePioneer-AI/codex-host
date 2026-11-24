import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  desktopExtensionsStatusPath,
  installHostExtension,
  readHostExtension,
  uninstallHostExtension,
  updateHostExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import {
  desktopExtensionsDiagnosticSchema,
  type DesktopExtensionStatus,
} from "@codexhost/shared-contracts";
import { extensionZip, makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import { RendererDesktopExtensions } from "../src/renderer-desktop-extensions.js";
import { createRendererCdpControlSession } from "../src/renderer-cdp-control-session.js";

let directory: string;
let root: string;
const controllers: RendererDesktopExtensions[] = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "extension-controller-"));
  root = path.join(directory, "host-extensions");
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.close();
  await rm(directory, { recursive: true, force: true });
});

async function install(id: string, script: string, slots: string[] = []) {
  return installZip(
    id,
    makeZip([
      {
        name: "manifest.json",
        data: JSON.stringify({
          manifestVersion: 2,
          id,
          version: "1",
          name: { en: id, "zh-CN": id },
          description: { en: id, "zh-CN": id },
          slots,
          desktop: { apiVersion: 1, script: "desktop.js" },
        }),
      },
      { name: "desktop.js", data: script },
    ]),
  );
}

async function installZip(id: string, zipBuffer: Buffer) {
  const current = await readHostExtension({ dataDir: directory, id });
  return installHostExtension({
    dataDir: directory,
    source: { type: "zip", zipBuffer },
    expectedDigest: current?.digest ?? null,
  });
}

async function enable(...ids: string[]) {
  for (const id of ids) await updateHostExtensionConfiguration(directory, { action: "enable", id });
}

function recover() {
  return updateHostExtensionConfiguration(directory, { action: "disableAll" });
}

function fakeRenderer(initial: Record<string, DesktopExtensionStatus> = {}) {
  let state = initial;
  type Module = {
    id: string;
    kind: string;
    hash: string;
    create?: () => Promise<{ namespace: unknown }>;
    error?: string;
  };
  const modules = new Map<string, Module>();
  const replace = (entries: Module[]) => {
    const previous = new Map(modules);
    modules.clear();
    for (const entry of entries) {
      const key = `${entry.id}:${entry.kind}`;
      const old = previous.get(key);
      if (entry.create || entry.error) modules.set(key, entry);
      else if (old?.hash === entry.hash) modules.set(key, old);
    }
  };
  const pages = new Map<string, string>();
  let nextScript = 0;
  const events: string[] = [];
  let reloads = 0;
  const evaluations: string[] = [];
  const largest = { entries: 0 };
  const window = {
    __codexhostDesktopExtensionsV1: {
      status: () => state,
      modules: {
        replace,
        status: () =>
          Object.fromEntries(
            [...modules].map(([key, { hash, error }]) => [
              key,
              {
                hash,
                state: error ? "failed" : "waiting",
                ...(error ? { error } : {}),
              },
            ]),
          ),
      },
      reconcile(
        entries: Array<{ id: string; hash: string; error?: string }>,
        moduleEntries: Module[],
      ) {
        replace(moduleEntries);
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
    modules.clear();
    for (const script of pages.values()) runInNewContext(script, context);
  };
  return {
    failBindingRead: false,
    failLiveApply: false,
    pages,
    events,
    evaluations,
    modules,
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

it("injects enabled surface-only generations, isolates a broken graph, and retires factories on uninstall and detach", async () => {
  async function installSurfaces(value: number) {
    return installZip(
      "surfaces",
      makeZip([
        {
          name: "manifest.json",
          data: JSON.stringify({
            manifestVersion: 2,
            id: "surfaces",
            version: String(value),
            name: { en: "Surfaces", "zh-CN": "页面与挂件" },
            description: { en: "Surfaces", "zh-CN": "页面与挂件" },
            page: { apiVersion: 1, entry: "page/index.mjs" },
            widget: { apiVersion: 1, entry: "widget/index.mjs" },
          }),
        },
        { name: "page/index.mjs", data: "export const invalid = ;" },
        { name: "widget/index.mjs", data: 'export { mount } from "../shared/timer.mjs";' },
        { name: "shared/timer.mjs", data: `export const mount = () => ${value};` },
      ]),
    );
  }
  await installSurfaces(1);
  const renderer = fakeRenderer();
  const c = controller();
  const detach = c.attach("target", renderer);
  await c.refresh();
  expect(renderer.modules.size).toBe(0);
  await enable("surfaces");
  await c.refresh();
  const mount = async () => {
    const loaded = await renderer.modules.get("surfaces:widget")?.create?.();
    return (loaded?.namespace as { mount(): number } | undefined)?.mount();
  };
  expect(await mount()).toBe(1);
  expect(renderer.modules.get("surfaces:page")?.error).toMatch(
    /page\/index\.mjs.*Unexpected token/s,
  );
  const diagnostics = desktopExtensionsDiagnosticSchema.parse(
    JSON.parse(await readFile(desktopExtensionsStatusPath(directory), "utf8")),
  );
  expect(diagnostics.surfaces?.["surfaces:page"]).toMatchObject({ state: "failed" });
  const readStarted = Promise.withResolvers<undefined>();
  const releaseRead = Promise.withResolvers<undefined>();
  const evaluate = renderer.evaluate.bind(renderer);
  vi.spyOn(renderer, "evaluate").mockImplementationOnce(async (expression) => {
    // Reconciliation has already discovered and linked the active generation at this point.
    readStarted.resolve(undefined);
    await releaseRead.promise;
    return evaluate(expression);
  });
  const oldScan = c.refresh();
  await readStarted.promise;
  let newScan: Promise<void>;
  try {
    await installSurfaces(2);
    newScan = c.refresh();
  } finally {
    releaseRead.resolve(undefined);
    await oldScan;
  }
  await newScan;
  expect(await mount()).toBe(2);
  renderer.reset();
  expect(await mount()).toBe(2);
  await uninstallHostExtension({ dataDir: directory, id: "surfaces" });
  await c.refresh();
  expect(renderer.modules.size).toBe(0);
  await installSurfaces(3);
  await enable("surfaces");
  await c.refresh();
  expect(await mount()).toBe(3);
  await detach();
  expect(renderer.modules.size).toBe(0);
  expect(renderer.pages.size).toBe(0);
  expect(renderer.reloads).toBe(0);
});

it("observes package replacements and uninstalls without polling or reloading Desktop", async () => {
  await installZip("sample", extensionZip());
  await enable("sample");
  const target = fakeRenderer();
  const extensions = controller();
  extensions.attach("target", target);
  await extensions.refresh();
  const original = target.state.sample;
  expect(original).toMatchObject({ state: "running", hash: expect.any(String) });
  const originalHash = original?.hash;
  if (!originalHash) throw new Error("Extension is not running");
  await installZip("sample", extensionZip({ version: "2.0.0" }));
  await expect
    .poll(() => target.state.sample)
    .toMatchObject({ state: "running", hash: expect.not.stringMatching(originalHash) });
  await uninstallHostExtension({ dataDir: directory, id: "sample" });
  await expect.poll(() => target.state).toEqual({});
  expect(target.pages.size).toBe(0);
  expect(target.reloads).toBe(0);
});

it("only injects enabled Desktop capabilities without a slot conflict", async () => {
  await install("badge", "define({activate(){}})", ["sidebar.thread-badge"]);
  await install("conflict", "define({activate(){}})", ["sidebar.thread-badge"]);
  await install("disabled", "define({activate(){}})");
  await installZip(
    "sample",
    extensionZip({
      manifest: { desktop: undefined, backend: { script: "backend.mjs" } },
      extras: [{ name: "backend.mjs", data: "export function activate() {}" }],
    }),
  );
  await enable("badge", "sample", "conflict");
  const renderer = fakeRenderer();
  const extensions = controller();
  extensions.attach("target", renderer);
  await extensions.refresh();
  expect(Object.keys(renderer.state)).toEqual(["badge"]);
  const doc = desktopExtensionsDiagnosticSchema.parse(
    JSON.parse(await readFile(desktopExtensionsStatusPath(directory), "utf8")),
  );
  expect(doc.extensions.conflict).toMatchObject({ state: "conflict", conflictWith: "badge" });
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
  await enable("tree", "badge");
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
    await enable("tree");
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

it("resends the script when the registered hash matches but its state is failed", async () => {
  const script = "/* badge body */ define({activate(){}})";
  await install("badge", script);
  await enable("badge");
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
  await enable("tree", "badge");
  const online = controller();
  const old = fakeRenderer();
  online.attach("target", old);
  await online.refresh();
  expect(Object.keys(old.state)).toEqual(["tree", "badge"]);
  online.close();
  old.close();
  await updateHostExtensionConfiguration(directory, { action: "disable", id: "tree" });
  old.reset();
  expect(old.state).toEqual({});
  const reconnected = controller();
  const active = fakeRenderer(old.state);
  reconnected.attach("target", active);
  await reconnected.refresh();
  expect(Object.keys(active.state)).toEqual(["badge"]);
});

it("reads before injecting on restart and clears the registered and live snapshots on recovery", async () => {
  await install("tree", "define({activate(){}})");
  await enable("tree");
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
  await recover();
  await second.refresh();
  expect(active.pages.size).toBe(0);
  expect(active.state).toEqual({});
  second.close();
  const third = controller();
  const recovered = fakeRenderer();
  third.attach("target", recovered);
  await third.refresh();
  expect(recovered.reloads).toBe(0);
});
