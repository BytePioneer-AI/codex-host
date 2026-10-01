import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

type RecordedRequest = { method: string; params: { model?: string } };

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installCurrentRendererAdapter } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { installRendererDraftPrewarmPolicyDirect } from "./packages/desktop-control/src/renderer-draft-prewarm-policy.ts";
      globalThis.setupHostRoutes = async (initialHostId, coMountedHostId, hidden = true) => {
        const createManager = (hostId) => {
          const calls = [];
          const requestClient = {
            hostId,
            sendRequest: async (method, params) => {
              calls.push({ method, params });
              if (method === "codexhost/settings/idle-release/set") return params;
              return { threadId: "thread-test", usage: null };
            },
            prewarmThreadStart: () => undefined,
            enqueueRequest: () => undefined,
            onResult: () => undefined,
            onError: () => undefined,
          };
          return {
            calls, requestClient,
            getHostId: () => hostId,
            sendRequest(method, params) { return this.requestClient.sendRequest(method, params); },
            prewarmedThreadManager: { discardAllPrewarmedThreads: () => undefined },
            onNotification: () => undefined,
            onRequest: () => undefined,
            dispatchAppServerResponse: () => undefined,
          };
        };
        const local = createManager("local");
        const remote = createManager("remote-ssh-discovered:linux");
        const managers = new Map([["local", local], [remote.getHostId(), remote]]);
        const registry = {
          addManager: () => undefined,
          getForHostId: (hostId) => managers.get(hostId),
          waitForManagerForHostId: () => undefined,
        };
        const editor = document.createElement("div");
        editor.setAttribute("data-codex-composer", "true");
        editor.setAttribute("data-codex-composer-root", "true");
        const fiber = {
          memoizedProps: { executionTargetHostId: initialHostId },
          memoizedState: { memoizedState: registry, next: { memoizedState: local, next: null } },
          return: null,
        };
        Object.defineProperty(editor, "__reactFiber$host", { value: fiber });
        document.body.replaceChildren(editor);
        let secondEditor = null;
        if (coMountedHostId) {
          secondEditor = document.createElement("div");
          secondEditor.setAttribute("data-codex-composer", "true");
          secondEditor.setAttribute("data-codex-composer-root", "true");
          secondEditor.hidden = hidden;
          Object.defineProperty(secondEditor, "__reactFiber$host", {
            value: { ...fiber, memoizedProps: { executionTargetHostId: coMountedHostId } },
          });
          document.body.append(secondEditor);
        }
        await installRendererDraftPrewarmPolicyDirect({ evaluate: (source) => (0, eval)(source) });
        const adapter = installCurrentRendererAdapter();
        globalThis.hostRoutes = { adapter, fiber, local, remote, managers, createManager, editor, secondEditor };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "renderer-host-routing-e2e.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Host routing browser bundle was not generated");
const browserBundle: string = bundle;

async function setup(
  page: Page,
  hostId: string,
  coMountedHostId?: string,
  hidden = true,
): Promise<void> {
  await page.route("https://codexhost.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("https://codexhost.test/");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(
    ({ initial, second, hidden }) =>
      Reflect.get(globalThis, "setupHostRoutes")(initial, second, hidden),
    { initial: hostId, second: coMountedHostId, hidden },
  );
}

for (const hostId of ["local", "remote-ssh-discovered:linux"]) {
  test(`both Hosts remain usable when ${hostId} opens first`, async ({ page }) => {
    await setup(page, hostId);
    const result = await page.evaluate(async () => {
      const state = Reflect.get(globalThis, "hostRoutes");
      const control = state.adapter.modelControl;
      const local = control.clientForHost("local");
      const remote = control.clientForHost(state.remote.getHostId());
      await Promise.all([
        local.inspectThreadUsage({ threadId: "thread-test" }),
        remote.inspectThreadUsage({ threadId: "thread-test" }),
      ]);
      const switched = [];
      for (const next of ["local", state.remote.getHostId(), "local"]) {
        state.fiber.memoizedProps.executionTargetHostId = next;
        switched.push(control.currentHostId());
        await control.inspectThreadUsage({ threadId: "thread-test" });
      }
      return {
        switched,
        stableLocal: local === control.clientForHost("local"),
        stableRemote: remote === control.clientForHost(state.remote.getHostId()),
        localCalls: state.local.calls.filter(
          (call: RecordedRequest) => call.method === "codexhost/thread/usage/inspect",
        ).length,
        remoteCalls: state.remote.calls.filter(
          (call: RecordedRequest) => call.method === "codexhost/thread/usage/inspect",
        ).length,
      };
    });
    expect(result).toEqual({
      switched: ["local", "remote-ssh-discovered:linux", "local"],
      stableLocal: true,
      stableRemote: true,
      localCalls: 3,
      remoteCalls: 2,
    });
  });
}

test("native disconnection retires only that Host, including while settings hide the Composer", async ({
  page,
}) => {
  await setup(page, "remote-ssh-discovered:linux");
  const result = await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "hostRoutes");
    const control = state.adapter.modelControl;
    const local = control.clientForHost("local");
    const remote = control.clientForHost(state.remote.getHostId());
    state.editor.remove();
    state.managers.delete(state.remote.getHostId());
    const missing = control.clientForHost(state.remote.getHostId());
    let retired = false;
    try {
      await remote.inspectThreadUsage({ threadId: "thread-test" });
    } catch {
      retired = true;
    }
    await local.inspectThreadUsage({ threadId: "thread-test" });
    state.managers.set(state.remote.getHostId(), state.createManager(state.remote.getHostId()));
    const replacement = control.clientForHost(state.remote.getHostId());
    await replacement.inspectThreadUsage({ threadId: "thread-test" });
    return {
      missing: missing === null,
      retired,
      replaced: replacement !== remote,
      localStable: control.clientForHost("local") === local,
    };
  });
  expect(result).toEqual({ missing: true, retired: true, replaced: true, localStable: true });
});

test("switching Hosts does not send a local external carrier to stock remote Codex", async ({
  page,
}) => {
  await setup(page, "local");
  const result = await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "hostRoutes");
    state.adapter.applyAgent("pi");
    state.fiber.memoizedProps.executionTargetHostId = state.remote.getHostId();
    state.adapter.modelControl.currentHostId();
    await state.remote.requestClient.sendRequest("thread/start", { model: "native-model" });
    await state.local.requestClient.sendRequest("thread/start", { model: "native-model" });
    state.adapter.dispose();
    await state.local.requestClient.sendRequest("thread/start", { model: "native-model" });
    return {
      remote: state.remote.calls
        .filter((call: RecordedRequest) => call.method === "thread/start")
        .map((call: RecordedRequest) => call.params.model),
      local: state.local.calls
        .filter((call: RecordedRequest) => call.method === "thread/start")
        .map((call: RecordedRequest) => call.params.model),
    };
  });
  expect(result).toEqual({
    remote: ["native-model"],
    local: ["codexhost/pi-native", "native-model"],
  });
});

for (const first of ["local", "remote-ssh-discovered:linux"]) {
  for (const hidden of [true, false]) {
    test(`mixed Hosts cold start (${first} first, second hidden: ${hidden})`, async ({ page }) => {
      const second = first === "local" ? "remote-ssh-discovered:linux" : "local";
      await setup(page, first, second, hidden);
      const result = await page.evaluate(async () => {
        const state = Reflect.get(globalThis, "hostRoutes");
        const { adapter, editor, secondEditor, managers } = state;
        const routing = window.__codexhostHostRoutingV1;
        if (!routing) throw new Error("Host routing was not installed");
        const control = adapter.modelControl;
        const firstHost = control.currentHostId(editor);
        const secondHost = control.currentHostId(secondEditor);
        const ready = [
          adapter.statusForComposer(editor).state,
          adapter.statusForComposer(secondEditor).state,
        ];
        const scoped = adapter.applyAgent("pi", undefined, undefined, undefined, editor);
        const global = adapter.applyAgent("pi");
        await state.local.requestClient.sendRequest("thread/start", { model: "native-model" });
        await state.remote.requestClient.sendRequest("thread/start", { model: "native-model" });
        managers.delete(secondHost);
        const disconnected = adapter.statusForComposer(secondEditor).state;
        const healthy = adapter.statusForComposer(editor).state;
        await control.clientForHost(firstHost).inspectThreadUsage({ threadId: "thread-test" });
        const answer = {
          firstHost,
          secondHost,
          ready,
          scoped,
          global,
          globalHost: control.currentHostId(),
          globalRoute: routing.forComposer(),
          singleton: window.__codexhostDraftPrewarmPolicyV1 !== undefined,
          disconnected,
          healthy,
          localModels: state.local.calls
            .filter((call: RecordedRequest) => call.method === "thread/start")
            .map((call: RecordedRequest) => call.params.model),
          remoteModels: state.remote.calls
            .filter((call: RecordedRequest) => call.method === "thread/start")
            .map((call: RecordedRequest) => call.params.model),
        };
        adapter.dispose();
        return answer;
      });
      expect(result).toEqual({
        firstHost: first,
        secondHost: second,
        ready: ["ready", "ready"],
        scoped: true,
        global: false,
        globalHost: null,
        globalRoute: null,
        singleton: false,
        disconnected: "installing",
        healthy: "ready",
        localModels: [first === "local" ? "codexhost/pi-native" : "native-model"],
        remoteModels: [first === "local" ? "native-model" : "codexhost/pi-native"],
      });
    });
  }
}

test("mixed Hosts publish scoped connection replacement without choosing a singleton", async ({
  page,
}) => {
  await setup(page, "local", "remote-ssh-discovered:linux");
  const result = await page.evaluate(async () => {
    const { adapter, editor, secondEditor, managers, createManager } = Reflect.get(
      globalThis,
      "hostRoutes",
    );
    const routing = window.__codexhostHostRoutingV1;
    if (!routing) throw new Error("Host routing was not installed");
    const local = routing.forComposer(editor);
    const remote = routing.forComposer(secondEditor);
    let changes = 0;
    const onChange = () => {
      changes += 1;
    };
    window.addEventListener("codexhost:draft-prewarm-policy-changed", onChange);
    managers.set("remote-ssh-discovered:linux", createManager("remote-ssh-discovered:linux"));
    const status = adapter.statusForComposer(secondEditor).state;
    const replacement = routing.forComposer(secondEditor);
    await Promise.resolve();
    const answer = {
      status,
      replaced: replacement !== remote,
      localUnchanged: routing.forComposer(editor) === local,
      changes,
      singleton: window.__codexhostDraftPrewarmPolicyV1 !== undefined,
    };
    window.removeEventListener("codexhost:draft-prewarm-policy-changed", onChange);
    adapter.dispose();
    return answer;
  });
  expect(result).toEqual({
    status: "ready",
    replaced: true,
    localUnchanged: true,
    changes: 1,
    singleton: false,
  });
});
