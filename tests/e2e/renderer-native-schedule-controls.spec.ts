import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererNativeScheduleControls } from "./packages/renderer-extension/src/renderer-native-schedule-controls.ts";
      import { isolateRendererPrewarmConsumption } from "./packages/desktop-control/src/renderer-prewarm-consumption.ts";
      import { decodeHarnessPluginRoute } from "./packages/shared-contracts/src/harness-route.ts";
      const svg = fill => "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="' + fill + '"/></svg>');
      const LOGO_PI = svg("#7c3aed"), LOGO_CLAUDE = svg("#d97757");
      window.setup = (config = {}) => {
        const starts = [], saved = [], turns = [], inspections = [], patches = [], workspacePreparations = [], discarded = [], inspectInputs = [];
        let finishWorkspace;
        const project = (id, cwd, projectKind = "local") => ({ source: "codex", group: { projectId: id, projectKind, label: id, path: cwd, rootPaths: [cwd] } });
        const projects = new Map([["Project A", project("Project A", "/work/项目 A")], ["Project B", project("Project B", "/work/B")], ["Remote", project("Remote", "/remote", "remote")]]);
        const aside = document.createElement("aside"), row = document.createElement("div");
        row.dataset.sidebarCycleItem = "true"; row.__reactFiber$workspace = { memoizedProps: { projectByKey: projects } };
        aside.append(row); document.body.append(aside);
        let props, form, owner, releaseSave, routeReady = true, currentClient, gone = false, modelCommits = 0;
        const deferred = new Map();
        let directoryRequests = 0;
        const availabilityListeners = new Set();
        const plugins = [
          { id: "pi", name: "Pi", icon: LOGO_PI }, { id: "claude-code", name: "Claude Code", icon: LOGO_CLAUDE },
          { id: "disconnected", name: "Disconnected" }, { id: "checking", name: "Checking" },
          { id: "usage-only", name: "Usage", kind: "usage" },
        ];
        let availability = config.coldCache ? {} : { pi: "ready", "claude-code": "ready", disconnected: "error", checking: "checking", "usage-only": "ready" };
        const manager = {
          threadCreation: { params: { prewarmedThreadManager: {
            hasPrewarmedThread: () => false, consumePrewarmedThread: async () => null, deletePrewarmedThread() {},
          } }, createConversation() {} },
          async startConversation(input) {
            starts.push({ input, route: decodeHarnessPluginRoute(input.collaborationMode.settings.model) });
            return { status: "created", conversationId: "scheduled-thread" };
          },
        };
        const policy = isolateRendererPrewarmConsumption(manager, () => {});
        policy.selectDraft("client-new-thread:ordinary", "codexhost/ordinary-pi");
        const client = {
          async listHarnessPlugins() { directoryRequests++; return { plugins }; },
          async inspectHarness(input) {
            const { harnessId } = input;
            inspections.push(harnessId); inspectInputs.push(input);
            if (config.delayModels) await new Promise(resolve => deferred.set(harnessId, resolve));
            if (config.delayWorkspaceModels && input.cwd) await new Promise(resolve => deferred.set(input.cwd, resolve));
            if (config.failedHarness === harnessId || (config.failedWorkspace && config.failedWorkspace === input.cwd)) throw Error("Harness unavailable");
            const id = config.workspaceModel && input.cwd === "/work/B" ? "workspace-model" : harnessId + "-model";
            const models = [{ ref: { id }, label: config.longModel ? harnessId + " model with an exceptionally long descriptive name that has to truncate gracefully" : id === "workspace-model" ? "Workspace Model" : harnessId + " model" }];
            if (config.extraModel) models.push({ ref: { id: harnessId + "-secondary" }, label: "Secondary Model" });
            return { status: "ready", catalog: { models, defaultModel: { id } } };
          },
        };
        currentClient = client;
        const commit = (modelOnly = false) => {
          if (gone) return;
          if (modelOnly) modelCommits++;
          if (config.nativeDefaultInitiallyMissing && patches.length && props.draft.model === null)
            props.draft = { ...props.draft, model: "gpt-native", reasoningEffort: "high" };
          owner.memoizedProps = { ...props, draft: { ...props.draft } };
          form.querySelector('[type="submit"]').disabled = props.isSaving || !props.draft.prompt.trim();
          if (!modelOnly || !config.silentModelCommit) {
            form.dataset.commit = String(Number(form.dataset.commit ?? 0) + 1);
            form.querySelector('[data-native-model] button').textContent = props.draft.model ?? "Default";
          }
        };
        const open = () => {
          gone = false;
          form = document.createElement("form"); form.dataset.density = "form";
          form.innerHTML = '<h2>Set up scheduled task</h2><fieldset data-native-audience><div>Personal task</div></fieldset><fieldset><div><label>Instructions<textarea>Task</textarea></label><p>Weekly Monday and Wednesday 13:15</p><div data-native-model><button type="button">GPT native</button></div><div data-native-effort><button type="button">High</button></div></div></fieldset><button type="submit">Create</button>';
          props = {
            setup: { triggerMode: config.edit ? "edit" : "create" }, executionLocation: config.cloud ? "cloud" : "local", isSaving: false,
            draft: { id: config.edit ? "existing" : null, kind: "heartbeat", targetThreadId: null, prompt: "Task", model: config.nativeDefaultInitiallyMissing ? null : "gpt-native", reasoningEffort: config.nativeDefaultInitiallyMissing ? null : "high", scheduleDirty: true, scheduleConfig: { mode: "weekly", weekdays: [1,3], time: "13:15" }, notificationPolicy: "important" },
            onChange(update) {
              patches.push("native-draft");
              if (config.ignoreSelection) return;
              const apply = () => { if (!gone) {
                const next = typeof update === "function" ? update(props.draft) : update;
                if (config.ignoreTarget && next.targetThreadId) return;
                props.draft = next; commit(true);
              } };
              if (config.nativeCommitDelay) setTimeout(apply, config.nativeCommitDelay);
              else queueMicrotask(apply);
            },
            onSubmit() {},
          };
          owner = { memoizedProps: props };
          const fiber = { stateNode: form, return: owner };
          form.__reactFiber$fixture = fiber;
          for (const [selector, id] of [["[data-native-model]", "inbox.automations.model.label"], ["[data-native-effort]", "automations.configuration.effort"]]) {
            const row = form.querySelector(selector), button = row.querySelector("button");
            button.__reactFiber$fixture = { stateNode: button, return: { stateNode: row, return: { memoizedProps: { label: { props: { id } } }, return: fiber } } };
          }
          form.querySelector("textarea").addEventListener("input", e => { props.draft = { ...props.draft, prompt: e.target.value }; commit(); });
          // Reviewed native flow: explicit Model -> empty chat -> heartbeat with
          // null Model/Effort -> native setup Turn. No codexhost CRUD is exposed.
          form.addEventListener("submit", async e => {
            e.preventDefault();
            if (props.isSaving || !props.draft.prompt.trim()) return;
            props.isSaving = true; commit();
            const draft = props.draft;
            const createsChat = !draft.targetThreadId;
            const result = createsChat
              ? await manager.startConversation({ input: [], cwd: "/native/workspace", collaborationMode: { mode: "default", settings: { model: draft.model, reasoning_effort: draft.reasoningEffort ?? "medium" } } }, {})
              : { conversationId: draft.targetThreadId };
            props.draft = { ...props.draft, targetThreadId: result.conversationId }; commit();
            if (config.holdSave) await new Promise(resolve => releaseSave = resolve);
            if (config.failSave) { props.isSaving = false; commit(); return; }
            saved.push({ kind: draft.kind, targetThreadId: result.conversationId, model: null, reasoningEffort: null, notificationPolicy: draft.notificationPolicy, rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=13;BYMINUTE=15", prompt: draft.prompt });
            if (createsChat) turns.push({ turnTrigger: "scheduled_task_setup" });
            props.isSaving = false;
            gone = true; form.remove();
          });
          document.querySelector("main").append(form); commit();
        };
        open();
        const control = installRendererNativeScheduleControls(document, {
          getClient: () => currentClient,
          getAvailablePlugins: () => currentClient === client ? plugins.filter(p => p.kind !== "usage" && availability[p.id] === "ready") : [],
          subscribeAvailability: listener => { availabilityListeners.add(listener); return () => availabilityListeners.delete(listener); },
          canRouteExternal: () => routeReady, locale: () => config.locale ?? "en",
          async createWorkspaceThread(input, signal) {
            workspacePreparations.push(input);
            if (config.prepareError) throw Error("Creation outcome unknown");
            if (config.holdWorkspace) await new Promise(resolve => finishWorkspace = resolve);
            const result = await manager.startConversation({ input: [], cwd: input.workspace.cwd, collaborationMode: { mode: "default", settings: { model: input.model } } }, {});
            let retained = false;
            const discard = () => { if (!retained) { retained = true; discarded.push(result.conversationId); } };
            signal.addEventListener("abort", discard, { once: true });
            if (signal.aborted) discard();
            signal.throwIfAborted();
            return { threadId: result.conversationId, retain() { retained = true; signal.removeEventListener("abort", discard); } };
          },
        });
        window.fixture = {
          starts, saved, turns, patches, inspections, workspacePreparations, discarded, inspectInputs, draft: () => props.draft, modelCommits: () => modelCommits,
          finishWorkspace: () => finishWorkspace?.(), allowSave: () => { config.failSave = false; },
          removeWorkspace: id => projects.delete(id),
          nativeModelHidden: () => form.querySelector("[data-native-model]").hidden,
          nativeEffortHidden: () => form.querySelector("[data-native-effort]").hidden,
          release: id => deferred.get(id)?.(), finish: () => releaseSave?.(),
          acceptModelChanges: () => { config.ignoreSelection = false; },
          directoryRequests: () => directoryRequests,
          availability: patch => { availability = { ...availability, ...patch }; for (const listener of availabilityListeners) listener(); },
          set: patch => { Object.assign(props, patch); commit(); control.refresh(); },
          draftPatch: patch => { props.draft = { ...props.draft, ...patch }; commit(); control.refresh(); },
          route: ready => { routeReady = ready; control.refresh(); },
          replaceClient: () => { currentClient = { ...client }; control.refresh(); },
          loseBinding: () => { owner.memoizedProps = {}; control.refresh(); },
          close: () => { gone = true; form.remove(); }, open, dispose: () => control.dispose(),
          submit: () => form.requestSubmit(),
          selectAndSubmit: value => { form.querySelector('[data-codexhost-schedule-controls]').shadowRoot.querySelector('.picker [role=option][data-value="' + value + '"]').click(); form.requestSubmit(); },
        };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  loader: { ".png": "dataurl" },
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Native schedule fixture bundle is missing");
async function setup(page: Page, config: Record<string, unknown> = {}) {
  await page.setContent(
    "<!doctype html><html><head><style>body{font:15px system-ui;background:Canvas;color:CanvasText}main{max-width:700px;margin:20px auto}form{padding:20px;border:1px solid #888;border-radius:20px}fieldset{border:0;padding:0}[data-native-model],[data-native-effort]{display:flex!important}textarea{display:block;box-sizing:border-box;width:100%;height:100px;margin:12px 0}button{padding:8px;margin:4px}</style></head><body><main></main></body></html>",
  );
  await page.addScriptTag({ content: bundle });
  await page.evaluate((config) => Reflect.get(window, "setup")(config), config);
}
async function act(page: Page, method: string, arg?: unknown) {
  return page.evaluate(({ method, arg }) => Reflect.get(window, "fixture")[method](arg), {
    method,
    arg,
  });
}
async function state(page: Page) {
  return page.evaluate(() => {
    const f = Reflect.get(window, "fixture");
    return {
      starts: f.starts,
      saved: f.saved,
      turns: f.turns,
      patches: f.patches,
      draft: f.draft(),
      workspacePreparations: f.workspacePreparations,
      discarded: f.discarded,
      inspectInputs: f.inspectInputs,
    };
  });
}
type PickerName = "Harness" | "Model" | "模型" | "Workspace";
const trigger = (page: Page, name: PickerName) => page.getByLabel(name, { exact: true });
const optionOf = (page: Page, name: PickerName, value: string) =>
  trigger(page, name).locator("..").locator(`[role="option"][data-value="${value}"]`);
async function pick(page: Page, name: PickerName, value: string) {
  await expect(optionOf(page, name, value)).toBeAttached();
  await trigger(page, name).click();
  await optionOf(page, name, value).click();
}
async function choose(page: Page, harness = "pi") {
  await pick(page, "Harness", harness);
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", `${harness}-model`);
  await expect.poll(async () => (await state(page)).draft.model).toMatch(/^codexhost\//);
}

test("workspace checks preserve the selected Model and its DOM without clearing or rewriting the draft", async ({
  page,
}) => {
  await setup(page, { delayWorkspaceModels: true, extraModel: true });
  await choose(page);
  await pick(page, "Model", "pi-secondary");
  await expect(trigger(page, "Model")).toBeEnabled();
  const before = await state(page);
  await trigger(page, "Model")
    .locator(".label")
    .evaluate((el) => el.setAttribute("data-preserved", "true"));
  await pick(page, "Workspace", "Project A");
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "pi-secondary");
  await expect(trigger(page, "Model")).toHaveAttribute("aria-busy", "false");
  await expect(trigger(page, "Model")).toBeEnabled();
  await expect(trigger(page, "Model").locator(".label")).toHaveAttribute("data-preserved", "true");
  await act(page, "submit");
  expect((await state(page)).workspacePreparations).toEqual([]);
  await expect(page.getByRole("status")).toContainText("Checking workspace models");
  await act(page, "release", "/work/项目 A");
  await expect(page.getByRole("status")).toBeHidden();
  await expect(trigger(page, "Model").locator(".label")).toHaveAttribute("data-preserved", "true");
  const after = await state(page);
  expect(after.draft.model).toBe(before.draft.model);
  expect(after.patches).toEqual(before.patches);
  await pick(page, "Workspace", "Project A");
  expect((await state(page)).inspectInputs).toHaveLength(2);
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0].route.model.id).toBe("pi-secondary");
});

test("missing workspace models require explicit reselection and ignore stale directory replies", async ({
  page,
}) => {
  await setup(page, { delayWorkspaceModels: true, workspaceModel: true });
  await choose(page);
  await pick(page, "Workspace", "Project A");
  await pick(page, "Workspace", "Project B");
  await act(page, "release", "/work/B");
  await expect(page.getByRole("status")).toContainText("selected Model is unavailable");
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "pi-model");
  await act(page, "submit");
  expect((await state(page)).workspacePreparations).toEqual([]);
  await pick(page, "Model", "workspace-model");
  await expect(trigger(page, "Model")).toBeEnabled();
  await act(page, "release", "/work/项目 A");
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "workspace-model");
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0]).toMatchObject({
    input: { cwd: "/work/B" },
    route: { model: { id: "workspace-model" } },
  });
});

test("failed background workspace checks keep the Model visible and block creation", async ({
  page,
}) => {
  await setup(page, { failedWorkspace: "/work/项目 A" });
  await choose(page);
  await expect(trigger(page, "Model")).toBeEnabled();
  const before = await state(page);
  await pick(page, "Workspace", "Project A");
  await expect(page.getByRole("status")).toContainText("Harness unavailable");
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "pi-model");
  await expect(trigger(page, "Model")).toHaveAttribute("aria-busy", "false");
  expect((await state(page)).patches).toEqual(before.patches);
  await act(page, "submit");
  expect((await state(page)).workspacePreparations).toEqual([]);
  await pick(page, "Workspace", "");
  await expect(page.getByRole("status")).toBeHidden();
});

test("external workspace selection prepares one native chat then saves its target through the official form", async ({
  page,
}) => {
  await setup(page, { silentModelCommit: true, nativeCommitDelay: 50 });
  await expect(trigger(page, "Workspace")).toBeHidden();
  await choose(page);
  await expect(trigger(page, "Workspace")).toHaveText("Automatic");
  await expect(optionOf(page, "Workspace", "Remote")).toHaveCount(0);
  await pick(page, "Workspace", "Project A");
  await expect(trigger(page, "Model")).toBeEnabled();
  await act(page, "submit");
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  const s = await state(page);
  expect(s.workspacePreparations).toHaveLength(1);
  expect(s.inspectInputs.at(-1)).toEqual({ harnessId: "pi", cwd: "/work/项目 A" });
  expect(s.starts).toHaveLength(1);
  expect(s.starts[0].input.cwd).toBe("/work/项目 A");
  expect(s.starts[0].route).toEqual({ harnessId: "pi", model: { id: "pi-model" } });
  expect(s.saved[0].targetThreadId).toBe("scheduled-thread");
  expect(s.turns).toEqual([]);
  expect(s.discarded).toEqual([]);
});

for (const reset of ["Automatic", "Codex"]) {
  test(`selecting ${reset} leaves the original creation path untouched`, async ({ page }) => {
    await setup(page);
    await choose(page);
    await pick(page, "Workspace", "Project A");
    await expect(trigger(page, "Model")).toBeEnabled();
    if (reset === "Codex") {
      await pick(page, "Harness", "codex");
      await expect(trigger(page, "Workspace")).toBeHidden();
      await expect(trigger(page, "Harness")).toBeEnabled();
    } else {
      await pick(page, "Workspace", "");
      await expect(trigger(page, "Model")).toBeEnabled();
    }
    await act(page, "submit");
    await expect.poll(async () => (await state(page)).saved.length).toBe(1);
    const s = await state(page);
    expect(s.workspacePreparations).toEqual([]);
    expect(s.starts[0].input.cwd).toBe("/native/workspace");
    expect(s.starts[0].route?.harnessId ?? "codex").toBe(reset === "Codex" ? "codex" : "pi");
    expect(s.turns).toEqual([{ turnTrigger: "scheduled_task_setup" }]);
  });
}

test("native validation and disappeared workspaces cannot create a chat", async ({ page }) => {
  await setup(page);
  await choose(page);
  await pick(page, "Workspace", "Project A");
  await expect(trigger(page, "Model")).toBeEnabled();
  await page.locator("textarea").fill("");
  await act(page, "submit");
  expect((await state(page)).workspacePreparations).toEqual([]);
  await page.locator("textarea").fill("Task");
  await act(page, "removeWorkspace", "Project A");
  await act(page, "submit");
  await expect(page.getByRole("status")).toContainText("workspace is no longer available");
  expect((await state(page)).workspacePreparations).toEqual([]);
});

test("failed official saves reuse the prepared chat and never archive a potentially saved target", async ({
  page,
}) => {
  await setup(page, { failSave: true });
  await choose(page);
  await pick(page, "Workspace", "Project A");
  await expect(trigger(page, "Model")).toBeEnabled();
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).draft.targetThreadId).toBe("scheduled-thread");
  await expect(trigger(page, "Harness")).toBeDisabled();
  await act(page, "allowSave");
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).workspacePreparations).toHaveLength(1);
  expect((await state(page)).discarded).toEqual([]);
});

test("closing during native preparation cleans up only its late empty chat and never saves a task", async ({
  page,
}) => {
  await setup(page, { holdWorkspace: true });
  await choose(page);
  await pick(page, "Workspace", "Project A");
  await expect(trigger(page, "Model")).toBeEnabled();
  await act(page, "submit");
  await act(page, "close");
  await expect(trigger(page, "Harness")).toHaveCount(0);
  await act(page, "finishWorkspace");
  await expect.poll(async () => (await state(page)).discarded).toEqual(["scheduled-thread"]);
  expect((await state(page)).saved).toEqual([]);
  await act(page, "open");
  await choose(page);
  await expect(trigger(page, "Workspace")).toHaveText("Automatic");
});

test("unknown creation outcomes cannot be retried by clicking Create again", async ({ page }) => {
  await setup(page, { prepareError: true });
  await choose(page);
  await pick(page, "Workspace", "Project A");
  await expect(trigger(page, "Model")).toBeEnabled();
  await act(page, "submit");
  await expect(page.getByRole("status")).toContainText("Check the chat list");
  await act(page, "submit");
  expect((await state(page)).workspacePreparations).toHaveLength(1);
  expect((await state(page)).saved).toEqual([]);
});

test("does not save or recreate when React never confirms the prepared target", async ({
  page,
}) => {
  await setup(page, { ignoreTarget: true });
  await choose(page);
  await pick(page, "Workspace", "Project A");
  await expect(trigger(page, "Model")).toBeEnabled();
  await act(page, "submit");
  await expect(page.getByRole("status")).toContainText("target chat was not confirmed", {
    timeout: 7000,
  });
  await act(page, "submit");
  expect((await state(page)).workspacePreparations).toHaveLength(1);
  expect((await state(page)).saved).toEqual([]);
  await act(page, "close");
  await expect.poll(async () => (await state(page)).discarded).toEqual(["scheduled-thread"]);
});

test("workspace picker shares the model picker's keyboard and narrow-screen layout", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await setup(page);
  await choose(page);
  await trigger(page, "Workspace").focus();
  await page.keyboard.press("ArrowDown");
  const menu = trigger(page, "Workspace").locator("..").getByRole("listbox");
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  if (!bounds) throw new Error("Workspace menu has no layout bounds");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("workspace-picker.png") });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger(page, "Workspace")).toContainText("Project A");
  await expect(menu).toBeHidden();
});

test("lists only ready Harnesses from the local cache without listing or probing plugins", async ({
  page,
}) => {
  await setup(page);
  const options = trigger(page, "Harness").locator("..").getByRole("option").locator(".label");
  await trigger(page, "Harness").click();
  await expect(options).toHaveText(["Codex", "Pi", "Claude Code"]);
  expect(await act(page, "directoryRequests")).toBe(0);
  await act(page, "availability", { pi: "checking", checking: "ready" });
  await expect(options).toHaveText(["Codex", "Claude Code", "Checking"]);
  await act(page, "close");
  await act(page, "open");
  await trigger(page, "Harness").click();
  await expect(options).toHaveText(["Codex", "Claude Code", "Checking"]);
  expect(await act(page, "directoryRequests")).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, "fixture").inspections)).toEqual([]);
});

test("a selected Harness disappearing from the ready cache cannot silently become Codex", async ({
  page,
}) => {
  await setup(page);
  await choose(page);
  await act(page, "availability", { pi: "error" });
  await expect(optionOf(page, "Harness", "pi")).toHaveCount(0);
  await act(page, "submit");
  expect((await state(page)).starts).toHaveLength(0);
  await expect(page.getByRole("status")).toContainText("no longer available");
  await pick(page, "Harness", "codex");
  await expect.poll(async () => (await state(page)).draft.model).toBe("gpt-native");
});

test("Codex stays native regardless of the ordinary draft Harness", async ({ page }) => {
  await setup(page);
  await expect(trigger(page, "Harness")).toHaveAttribute("data-value", "codex");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  const result = await state(page);
  expect(result.starts[0].input.collaborationMode.settings.model).toBe("gpt-native");
  expect(result.starts[0].route).toBeNull();
  expect(result.patches).toEqual([]);
});

test("external selection uses native submission, recurrence, notifications and setup exactly once", async ({
  page,
}) => {
  await setup(page, { holdSave: true });
  await choose(page, "claude-code");
  await expect(
    page.locator("[data-native-audience] [data-codexhost-schedule-controls]"),
  ).toHaveCount(0);
  expect(await act(page, "nativeModelHidden")).toBe(true);
  expect(await act(page, "nativeEffortHidden")).toBe(true);
  await expect(page.locator("[data-native-model]")).toBeHidden();
  await expect(page.locator("[data-native-effort]")).toBeHidden();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await act(page, "submit");
  await expect(page.getByLabel("Harness", { exact: true })).toBeDisabled();
  await act(page, "finish");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  const result = await state(page);
  expect(result.starts).toHaveLength(1);
  expect(result.starts[0].route).toEqual({
    harnessId: "claude-code",
    model: { id: "claude-code-model" },
  });
  expect(result.starts[0].input.input).toEqual([]);
  expect(result.saved[0]).toMatchObject({
    kind: "heartbeat",
    model: null,
    reasoningEffort: null,
    notificationPolicy: "important",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=13;BYMINUTE=15",
  });
  expect(result.turns).toEqual([{ turnTrigger: "scheduled_task_setup" }]);
});

test("switching back restores Codex before allowing native submission", async ({ page }) => {
  await setup(page);
  await choose(page);
  await act(page, "selectAndSubmit", "codex");
  expect((await state(page)).starts).toEqual([]);
  await expect.poll(async () => (await state(page)).draft.model).toBe("gpt-native");
  expect((await state(page)).draft.reasoningEffort).toBe("high");
  await expect.poll(() => act(page, "nativeModelHidden")).toBe(false);
  await expect(page.locator("[data-native-model]")).toBeVisible();
  expect(await page.locator("[data-native-model]").evaluate((row) => row.style.display)).toBe("");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0].route).toBeNull();
});

test("returning to an implicit Codex Model permits native default normalization", async ({
  page,
}) => {
  await setup(page, { nativeDefaultInitiallyMissing: true });
  await choose(page);
  await pick(page, "Harness", "codex");
  await expect.poll(async () => (await state(page)).draft.model).toBe("gpt-native");
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0].route).toBeNull();
});

test("ignores stale catalogs and does not leak selection to a reopened dialog", async ({
  page,
}) => {
  await setup(page, { delayModels: true });
  await pick(page, "Harness", "pi");
  await act(page, "submit");
  expect((await state(page)).starts).toEqual([]);
  await pick(page, "Harness", "claude-code");
  await act(page, "release", "pi");
  expect((await state(page)).draft.model).toBe("gpt-native");
  await act(page, "release", "claude-code");
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "claude-code-model");
  await act(page, "close");
  await act(page, "open");
  await expect(trigger(page, "Harness")).toHaveAttribute("data-value", "codex");
  expect((await state(page)).draft.model).toBe("gpt-native");
});

for (const mode of [
  "cloud",
  "cron",
  "goal",
  "lost-binding",
  "lost-route",
  "changed-model",
  "changed-client",
]) {
  test(`blocks external submission for ${mode} without falling back to Codex`, async ({ page }) => {
    await setup(page);
    await choose(page);
    await expect(trigger(page, "Model")).toBeEnabled();
    if (mode === "cloud") await act(page, "set", { executionLocation: "cloud" });
    if (mode === "cron") await act(page, "draftPatch", { kind: "cron" });
    if (mode === "goal") await act(page, "set", { creation: { type: "goal" } });
    if (mode === "lost-binding") await act(page, "loseBinding");
    if (mode === "lost-route") await act(page, "route", false);
    if (mode === "changed-model") await act(page, "draftPatch", { model: "gpt-other" });
    if (mode === "changed-client") await act(page, "replaceClient");
    await act(page, "submit");
    expect((await state(page)).starts).toEqual([]);
    await expect(page.getByRole("status")).toBeVisible();
  });
}

test("returning to Codex cannot bypass a lost draft binding", async ({ page }) => {
  await setup(page);
  await choose(page);
  await act(page, "loseBinding");
  await act(page, "selectAndSubmit", "codex");
  expect((await state(page)).starts).toEqual([]);
  await expect(page.getByRole("status")).toContainText("Restoring Codex");
});

test("unavailable Harness does not submit a native fallback and Codex remains usable", async ({
  page,
}) => {
  await setup(page, { failedHarness: "pi" });
  await pick(page, "Harness", "pi");
  await expect(page.getByRole("status")).toContainText("Harness unavailable");
  await act(page, "submit");
  expect((await state(page)).starts).toEqual([]);
  await pick(page, "Harness", "codex");
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0].route).toBeNull();
});

test("cloud and edit dialogs are not external creation entry points", async ({ page }) => {
  await setup(page, { cloud: true });
  const option = optionOf(page, "Harness", "pi");
  await expect(option).toHaveAttribute("aria-disabled", "true");
  await act(page, "set", { executionLocation: "local" });
  await expect(option).not.toHaveAttribute("aria-disabled");
  await setup(page, { edit: true });
  await expect(page.getByLabel("Harness", { exact: true })).toHaveCount(0);
});

test("disposal restores only the task's captured native Model and rows", async ({ page }) => {
  await setup(page);
  await choose(page);
  await act(page, "dispose");
  await expect(page.getByLabel("Harness", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await state(page)).draft.model).toBe("gpt-native");
  expect(await act(page, "nativeModelHidden")).toBe(false);
  expect((await state(page)).starts).toEqual([]);
});

test("acknowledges a delayed native Model commit without any DOM mutation", async ({ page }) => {
  await setup(page, { silentModelCommit: true, nativeCommitDelay: 180 });
  const model = page.getByLabel("Model", { exact: true });
  await pick(page, "Harness", "pi");
  await expect(model).toHaveAttribute("data-value", "pi-model");
  await expect(model).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status")).not.toBeVisible();
  await act(page, "submit");
  expect((await state(page)).starts).toHaveLength(0);
  await expect(model).toHaveAttribute("aria-busy", "false");
  await expect(model).toBeEnabled();
  await expect(page.getByRole("status")).not.toBeVisible();
  expect((await state(page)).patches).toHaveLength(1);
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0].route.harnessId).toBe("pi");
});

test("switching back during an uncommitted Model change restores Codex", async ({ page }) => {
  await setup(page, { silentModelCommit: true, nativeCommitDelay: 180 });
  await pick(page, "Harness", "pi");
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "pi-model");
  await pick(page, "Harness", "codex");
  await expect.poll(async () => (await state(page)).patches.length).toBe(2);
  await expect.poll(() => act(page, "modelCommits")).toBe(2);
  expect((await state(page)).draft.model).toBe("gpt-native");
  await act(page, "submit");
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0].route).toBeNull();
});

test("a native setter that does not commit offers explicit retry, never automatic writes", async ({
  page,
}) => {
  await setup(page, { ignoreSelection: true });
  await pick(page, "Harness", "pi");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({
    timeout: 7000,
  });
  expect((await state(page)).patches).toHaveLength(1);
  expect((await state(page)).starts).toHaveLength(0);
  await act(page, "acceptModelChanges");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();
  await expect(page.getByRole("status")).not.toBeVisible();
  expect((await state(page)).patches).toHaveLength(2);
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [390, 900]) {
    test(`stable native rows while loading at ${width}px in ${colorScheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 780 });
      await setup(page, { locale: "zh-CN", delayModels: true });
      await page.evaluate(() => (document.documentElement.style.colorScheme = "light dark"));
      const model = trigger(page, "模型");
      const controls = page.locator("[data-codexhost-schedule-controls]");
      await pick(page, "Harness", "pi");
      await expect(model).toHaveText("正在加载模型…");
      await expect(model).toHaveAttribute("aria-busy", "true");
      await expect(model).toBeDisabled();
      await expect(page.getByRole("status")).not.toBeVisible();
      const height = (await controls.boundingBox())?.height;
      await page.screenshot({ path: info.outputPath(`loading-${width}-${colorScheme}.png`) });
      await act(page, "release", "pi");
      await expect(model).toBeEnabled();
      await expect(page.getByRole("status")).not.toBeVisible();
      expect((await controls.boundingBox())?.height).toBe(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath(`ready-${width}-${colorScheme}.png`) });
      await trigger(page, "Harness").click();
      await page.screenshot({ path: info.outputPath(`menu-${width}-${colorScheme}.png`) });
    });
  }
}

test("shows real Logos for the selected Harness and every menu item", async ({ page }) => {
  await setup(page);
  const logo = (scope: ReturnType<typeof trigger>) => scope.locator("img");
  await expect(logo(trigger(page, "Harness"))).toHaveCount(1);
  await trigger(page, "Harness").click();
  const items = trigger(page, "Harness").locator("..").getByRole("option");
  await expect(items.locator("img")).toHaveCount(3);
  const sources = await items
    .locator("img")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLImageElement).src));
  expect(sources[1]).toContain("%237c3aed");
  expect(sources[2]).toContain("%23d97757");
  await optionOf(page, "Harness", "pi").click();
  expect(await logo(trigger(page, "Harness")).getAttribute("src")).toContain("%237c3aed");
  // The Model row has no brand Logo.
  await expect(trigger(page, "Model").locator("img")).toHaveCount(0);
});

test("picker is keyboard operable and closes on Escape and outside click without closing the form", async ({
  page,
}) => {
  await setup(page);
  const harness = trigger(page, "Harness");
  const menu = page.getByRole("listbox", { name: "Choose a Harness" });
  await harness.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  await expect(harness).toHaveAttribute("aria-expanded", "true");
  await expect(optionOf(page, "Harness", "codex")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(optionOf(page, "Harness", "pi")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(harness).toBeFocused();
  await expect(page.locator("form")).toBeVisible();
  await harness.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(optionOf(page, "Harness", "claude-code")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(harness).toHaveAttribute("data-value", "claude-code");
  await expect(harness).toBeFocused();
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "claude-code-model");
  await harness.click();
  await expect(menu).toBeVisible();
  await page.locator("textarea").click();
  await expect(menu).toBeHidden();
  await expect(harness).toHaveAttribute("data-value", "claude-code");
});

test("long Model labels truncate inside the row at 390px", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await setup(page, { longModel: true });
  await pick(page, "Harness", "pi");
  await expect(trigger(page, "Model")).toHaveAttribute("data-value", "pi-model");
  await page.screenshot({ path: info.outputPath("long-model-390.png") });
  const box = await trigger(page, "Model").boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await trigger(page, "Model").click();
  const menuBox = await page.getByRole("listbox", { name: "Choose a Model" }).boundingBox();
  expect(menuBox && menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox && menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("long-model-menu-390.png") });
});

test("a cold empty cache still shows Codex with its Logo and fills in when Harnesses become ready", async ({
  page,
}) => {
  await setup(page, { coldCache: true });
  const harness = trigger(page, "Harness");
  const options = harness.locator("..").getByRole("option");
  await expect(harness).toHaveAttribute("data-value", "codex");
  await expect(harness).toContainText("Codex");
  await expect(harness.locator("img")).toHaveCount(1);
  await harness.click();
  await expect(options.locator(".label")).toHaveText(["Codex"]);
  await expect(options.locator("img")).toHaveCount(1);
  await page.keyboard.press("Escape");
  expect(await act(page, "directoryRequests")).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, "fixture").inspections)).toEqual([]);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(async () => (await state(page)).saved.length).toBe(1);
  expect((await state(page)).starts[0].route).toBeNull();
  expect((await state(page)).starts[0].input.collaborationMode.settings.model).toBe("gpt-native");
  await act(page, "close");
  await act(page, "open");
  await act(page, "availability", { pi: "ready", "claude-code": "ready", checking: "checking" });
  await harness.click();
  await expect(options.locator(".label")).toHaveText(["Codex", "Pi", "Claude Code"]);
  await expect(harness).toHaveAttribute("data-value", "codex");
  expect(await act(page, "directoryRequests")).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, "fixture").inspections)).toEqual([]);
});
