import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
} from "@codexhost/shared-contracts";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

type RecordedRequest = {
  method: string;
  params: { model?: string; threadId?: string; input?: unknown[] };
};

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installCurrentRendererAdapter } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { installRendererDraftPrewarmPolicyDirect } from "./packages/desktop-control/src/renderer-draft-prewarm-policy.ts";
      globalThis.setupHostRoutes = async (initialHostId, config = {}) => {
        const createManager = (hostId) => {
          const calls = [], created = [];
          let warmed = null;
          const pool = {
            hasPrewarmedThread: () => warmed !== null,
            consumePrewarmedThread: async () => { const result = warmed; warmed = null; return result; },
            deletePrewarmedThread: () => undefined,
            discardAllPrewarmedThreads: () => { warmed = null; },
          };
          const requestClient = {
            hostId,
            sendRequest: async (method, params) => {
              calls.push({ method, params });
              if (method === "codexhost/settings/idle-release/set") return params;
              if (method === "thread/start") {
                const response = { thread: { id: "thread-" + calls.length }, model: params.model };
                created.push(response);
                return response;
              }
              return { threadId: "thread-test", usage: null };
            },
            prewarmThreadStart: () => undefined,
            enqueueRequest: () => undefined,
            onResult: () => undefined,
            onError: () => undefined,
          };
          return {
            calls, created, requestClient, seedPrewarm: value => { warmed = value; },
            threadCreation: {
              params: { prewarmedThreadManager: pool },
              async createConversation(input) {
                await Promise.resolve();
                let prepared = null;
                if (this.params.prewarmedThreadManager.hasPrewarmedThread(input.cwd))
                  prepared = await this.params.prewarmedThreadManager.consumePrewarmedThread(input.cwd);
                return prepared?.response ?? requestClient.sendRequest("thread/start", { model: input.collaborationMode.settings.model, cwd: input.cwd });
              },
            },
            async startConversation(input, options) {
              const response = await this.threadCreation.createConversation(input);
              if (input.input.length) await this.sendRequest("turn/start", { threadId: response.thread.id, input: input.input, collaborationMode: input.collaborationMode });
              return response;
            },
            getHostId: () => hostId,
            sendRequest(method, params) { return this.requestClient.sendRequest(method, params); },
            prewarmedThreadManager: pool,
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
        let draft = { modelSettings: config.emptyDraft ? null : { model: "native-model", reasoningEffort: "high" }, isManuallyChanged: false };
        const usesAccountPreferences = config.usesAccountPreferences ?? false;
        const updateDraft = (update) => {
          draft = update(draft);
          row[10] = draft;
          row[13].draftSettings = draft;
        };
        const row = Array(14).fill(null);
        Object.assign(row, { 6: "client-new-thread:fixture", 7: "client-new-thread:fixture", 9: updateDraft,
          10: draft, 11: true, 12: updateDraft, 13: { draftSettings: draft, isNewThreadDraft: true, updateDraftSettings: updateDraft } });
        const modelContext = { usesAccountPreferences, modelSettings: { model: "native-model", reasoningEffort: "high" } };
        const modelRow = Array(24).fill(null);
        const setModel = () => {};
        Object.assign(modelRow, { 7: null, 10: true, 12: modelContext, 13: updateDraft, 14: setModel,
          20: setModel, 21: modelContext, 23: { ...modelContext,
            modelSettings: { ...modelContext.modelSettings, model: config.reserveActive ? "gpt-reserve" : "native-model" },
            setModelAndReasoningEffort: setModel } });
        const nativeMode = { mode: "default", settings: { model: config.reserveActive ? "gpt-reserve" : "native-model", reasoning_effort: "high" } };
        const modeRow = Array(52).fill(null);
        Object.assign(modeRow, { 39: modelRow[23].modelSettings.model, 40: modelContext.modelSettings.reasoningEffort,
          41: nativeMode.settings, 44: nativeMode, 49: nativeMode, 51: { activeMode: nativeMode } });
        const secondUpdate = update => updateDraft(update);
        const secondDraftRow = Object.assign([...row], { 9: secondUpdate, 12: secondUpdate,
          13: { draftSettings: draft, isNewThreadDraft: true, updateDraftSettings: secondUpdate } });
        const secondModelRow = Object.assign([...modelRow], { 13: secondUpdate });
        fiber.updateQueue = { memoCache: { data: [row, modeRow, modelRow, secondDraftRow, secondModelRow] } };
        Object.defineProperty(editor, "__reactFiber$host", { value: fiber });
        const form = document.createElement("form");
        form.innerHTML = '<button type="submit">Send</button>';
        form.prepend(editor);
        form.addEventListener("submit", event => {
          event.preventDefault();
          // Desktop 26.1021 Hlo accepts a scoped Model only in its current settings mode.
          const settings = draft.modelSettings?.usesAccountPreferences === usesAccountPreferences
            ? draft.modelSettings : { model: "native-model", reasoningEffort: "high" };
          const model = config.reserveActive ? "gpt-reserve" : settings.model;
          const collaborationMode = { ...nativeMode, settings: { ...nativeMode.settings, model } };
          void local.startConversation({ cwd: "/same-cwd", collaborationMode, input: [{ type: "text", text: "regression message" }] }, { clientThreadId: config.background ? "client-new-thread:background" : "client-new-thread:fixture" });
        });
        document.body.replaceChildren(form);
        await installRendererDraftPrewarmPolicyDirect({ evaluate: (source) => (0, eval)(source) });
        const adapter = installCurrentRendererAdapter();
        globalThis.hostRoutes = { adapter, fiber, local, remote, managers, createManager, editor, readDraft: () => draft };
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
  config: Record<string, unknown> = {},
): Promise<void> {
  await page.route("https://codexhost.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("https://codexhost.test/");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(
    ({ hostId, config }) => Reflect.get(globalThis, "setupHostRoutes")(hostId, config),
    { hostId, config },
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
    state.adapter.applyAgent("pi", undefined, undefined, undefined, state.editor);
    state.fiber.memoizedProps.executionTargetHostId = state.remote.getHostId();
    state.adapter.modelControl.currentHostId();
    state.adapter.applyAgent("codex", undefined, undefined, undefined, state.editor);
    await state.remote.requestClient.sendRequest("thread/start", { model: "native-model" });
    await state.local.requestClient.sendRequest("thread/start", { model: "native-model" });
    state.adapter.dispose();
    await state.local.requestClient.sendRequest("thread/start", { model: "native-model" });
    return {
      restoredDraft: state.readDraft().modelSettings.model,
      remote: state.remote.calls
        .filter((call: RecordedRequest) => call.method === "thread/start")
        .map((call: RecordedRequest) => call.params.model),
      local: state.local.calls
        .filter((call: RecordedRequest) => call.method === "thread/start")
        .map((call: RecordedRequest) => call.params.model),
    };
  });
  expect(result).toEqual({
    restoredDraft: "native-model",
    remote: ["native-model"],
    local: ["native-model", "native-model"],
  });
});

test("only the identified external draft carries its selection into native request forwarding", async ({
  page,
}) => {
  await setup(page, "local");
  const result = await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "hostRoutes");
    const selected = state.adapter.applyAgent(
      "pi",
      { id: "pi-test" },
      undefined,
      undefined,
      state.editor,
    );
    const draft = state.readDraft();
    await Promise.all([
      state.local.requestClient.sendRequest("thread/start", { model: "official-task-model" }),
      state.local.requestClient.sendRequest("thread/start", { model: draft.modelSettings.model }),
    ]);
    state.adapter.applyAgent("codex", undefined, undefined, undefined, state.editor);
    return {
      selected,
      persist: draft.modelSettingsPersistAsDefault,
      external: draft.modelSettings.model,
      requests: state.local.calls
        .filter((call: RecordedRequest) => call.method === "thread/start")
        .map((call: RecordedRequest) => call.params.model),
      restored: state.readDraft().modelSettings.model,
    };
  });
  expect(result.selected).toBe(true);
  expect(result.persist).toBe(false);
  expect(result.external).toMatch(/^codexhost\//u);
  expect(result.requests).toEqual(["official-task-model", result.external]);
  expect(result.restored).toBe("native-model");
});

for (const reserveActive of [false, true]) {
  for (const usesAccountPreferences of [false, true]) {
    for (const agent of ["pi", "claude-code", "opencode"]) {
      test(`Send creates and starts ${agent} with account preferences ${usesAccountPreferences} and reserve ${reserveActive}`, async ({
        page,
      }) => {
        await setup(page, "local", { emptyDraft: true, usesAccountPreferences, reserveActive });
        const applied = await page.evaluate((agent) => {
          const state = Reflect.get(globalThis, "hostRoutes");
          return state.adapter.applyAgent(
            agent,
            { id: "regression-model" },
            undefined,
            undefined,
            state.editor,
          );
        }, agent);
        expect(applied).toBe(true);
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                Reflect.get(globalThis, "hostRoutes").local.calls.filter(
                  (call: RecordedRequest) => call.method === "turn/start",
                ).length,
            ),
          )
          .toBe(1);
        const calls: RecordedRequest[] = await page.evaluate(() =>
          Reflect.get(globalThis, "hostRoutes").local.calls.filter((call: RecordedRequest) =>
            ["thread/start", "turn/start"].includes(call.method),
          ),
        );
        const createdThreadId = await page.evaluate(
          () => Reflect.get(globalThis, "hostRoutes").local.created[0].thread.id,
        );
        expect(calls).toEqual([
          {
            method: "thread/start",
            params: {
              model: encodeHarnessPluginRoute({
                harnessId: harnessIdSchema.parse(agent),
                model: harnessModelRefSchema.parse({ id: "regression-model" }),
              }),
              cwd: "/same-cwd",
            },
          },
          {
            method: "turn/start",
            params: {
              threadId: createdThreadId,
              input: [{ type: "text", text: "regression message" }],
              collaborationMode: {
                mode: "default",
                settings: {
                  model: encodeHarnessPluginRoute({
                    harnessId: harnessIdSchema.parse(agent),
                    model: harnessModelRefSchema.parse({ id: "regression-model" }),
                  }),
                  reasoning_effort: "high",
                },
              },
            },
          },
        ]);
      });
    }
  }
}

test("ordinary Send, official tasks and explicit external schedules retain independent routes", async ({
  page,
}) => {
  await setup(page, "local", { emptyDraft: true, usesAccountPreferences: true });
  const result = await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "hostRoutes");
    state.adapter.applyAgent("pi", undefined, undefined, undefined, state.editor);
    const ordinaryModel = state.readDraft().modelSettings.model;
    state.local.seedPrewarm({
      response: { thread: { id: "ordinary-prewarm" }, model: ordinaryModel },
    });
    const route = window.__codexhostHostRoutingV1?.forHost("local");
    if (!route) throw new Error("Local route unavailable");
    const policy = route.policy;
    await policy.createScheduledConversation(
      {
        cwd: "/same-cwd",
        collaborationMode: { mode: "default", settings: { model: "codexhost/claude-code-native" } },
      },
      () => ({}),
    );
    const retainedOrdinaryPrewarm = state.local.prewarmedThreadManager.hasPrewarmedThread();
    // An official task must reject the external prewarm and use its own Model.
    await state.local.startConversation({
      cwd: "/same-cwd",
      collaborationMode: { mode: "default", settings: { model: "official-task-model" } },
      input: [],
    });
    return { retainedOrdinaryPrewarm, ordinaryModel };
  });
  expect(result.retainedOrdinaryPrewarm).toBe(true);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(globalThis, "hostRoutes").local.calls.filter(
            (call: RecordedRequest) => call.method === "turn/start",
          ).length,
      ),
    )
    .toBe(1);
  const calls: RecordedRequest[] = await page.evaluate(
    () => Reflect.get(globalThis, "hostRoutes").local.calls,
  );
  expect(
    calls
      .filter((call: RecordedRequest) => call.method === "thread/start")
      .map((call) => call.params.model),
  ).toEqual(["codexhost/claude-code-native", "official-task-model", result.ordinaryModel]);
  expect(
    calls.filter((call: RecordedRequest) => call.method === "codexhost/thread/prewarm/discard"),
  ).toEqual([
    { method: "codexhost/thread/prewarm/discard", params: { threadId: "ordinary-prewarm" } },
  ]);
  expect(calls.find((call: RecordedRequest) => call.method === "turn/start")?.params.input).toEqual(
    [{ type: "text", text: "regression message" }],
  );
});

test("a draft cannot borrow a Model settings mode from an unrelated setter", async ({ page }) => {
  await setup(page, "local", { emptyDraft: true });
  const result = await page.evaluate(() => {
    const state = Reflect.get(globalThis, "hostRoutes");
    state.fiber.updateQueue.memoCache.data[2][13] = () => {};
    state.fiber.updateQueue.memoCache.data[4][13] = () => {};
    return {
      applied: state.adapter.applyAgent("pi", undefined, undefined, undefined, state.editor),
      settings: state.readDraft().modelSettings,
    };
  });
  expect(result).toEqual({ applied: false, settings: null });
});

test("background Send retains its originating external draft in reserve mode", async ({ page }) => {
  await setup(page, "local", {
    emptyDraft: true,
    usesAccountPreferences: true,
    reserveActive: true,
    background: true,
  });
  expect(
    await page.evaluate(() => {
      const state = Reflect.get(globalThis, "hostRoutes");
      return state.adapter.applyAgent("pi", undefined, undefined, undefined, state.editor);
    }),
  ).toBe(true);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "hostRoutes").local.created[0]?.model))
    .toBe(encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") }));
});
