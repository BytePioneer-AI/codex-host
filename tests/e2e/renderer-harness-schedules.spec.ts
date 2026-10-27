import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
    import { createDesktopScheduleManagement } from "./packages/desktop-control/src/desktop-harness-schedule-management.ts";
    import { createHarnessSchedulesPage } from "./packages/renderer-extension/src/settings/harness-schedules-page.ts";
    import { createDefaultRendererSettingsPages } from "./packages/renderer-extension/src/settings/pages.ts";
    import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
    import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
    import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
    import { installRendererSettingsLifecycle } from "./packages/renderer-extension/src/renderer-settings-lifecycle.ts";
    import { openCodexLocalThread } from "./packages/renderer-extension/src/codex-thread-navigation.ts";
    globalThis.setupSchedules = (config = {}) => {
      document.documentElement.style.colorScheme = config.scheme ?? "light";
      const calls = [], opened = [], writes = [];
      let complete, aborted = false, listCount = 0, holdNextList = false, releaseList, releaseWrite;
      let items = structuredClone(config.items ?? []);
      const native = {
        assertAvailable() {},
        async listAutomations() {
          listCount++;
          const result = { items: structuredClone(items) };
          if (holdNextList) { holdNextList = false; return new Promise(resolve => { releaseList = () => resolve(result); }); }
          return result;
        },
        async readOwnership(threadId) {
          if (config.unreadableThread === threadId) throw Error("Ownership unavailable");
          const item = items.find(item => item.targetThreadId === threadId);
          return { threadId, owner: item?.official ? "codex" : "external", harnessId: item?.harnessId ?? "pi" };
        },
        async updateAutomation(params) {
          writes.push({ method: "update", params });
          const index = items.findIndex(item => item.id === params.id);
          if (config.pendingUpdate) return new Promise(resolve => { releaseWrite = () => { items[index] = { ...items[index], ...params }; resolve({ item: structuredClone(items[index]) }); }; });
          items[index] = { ...items[index], ...params };
          if (config.unknownWrite) throw Object.assign(Error("internal failure after commit"), { jsonRpcCode: -32603 });
          return { item: structuredClone(items[index]) };
        },
        async deleteAutomation(id) { writes.push({ method: "delete", id }); items = items.filter(item => item.id !== id); return { success: true, status: "deleted" }; },
        async refreshList() {},
      };
      const connection = { ...createDesktopScheduleManagement(native), creationUnavailableReason: config.creationUnavailableReason, createSession: () => ({
        submit(input, signal) {
          calls.push(input); signal.addEventListener("abort", () => aborted = true);
          return new Promise(resolve => {
            complete = () => {
              if ((config.outcome ?? "saved") === "saved") items.push({ id: "created", kind: "heartbeat", targetThreadId: "ffb4571e-d945-4f3e-8ce4-1db511796000", name: input.prompt, prompt: input.prompt, harnessId: input.harnessId, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" });
              resolve({ outcome: config.outcome ?? "saved", retryable: false, threadId: "ffb4571e-d945-4f3e-8ce4-1db511796000", cwd: input.cwd || "/desktop/default" });
            };
            if (!config.pending) complete();
          });
        }
      }) };
      const client = {
        listHarnessPlugins: async () => ({ plugins: [{ id: "pi", name: "Pi" }, { id: "claude-code", name: "Claude Code" }, { id: "usage-only", name: "Usage", kind: "usage" }] }),
        inspectHarness: async ({ harnessId }) => ({ status: "ready", catalog: { models: [{ ref: { id: harnessId + "-model" }, label: harnessId + " model" }], defaultModel: { id: harnessId + "-model" } } }),
      };
      const page = createHarnessSchedulesPage(rendererSettingsMessages(config.locale ?? "en"), {
        getModelClient: () => client,
        connect: async () => { if (config.unavailable) throw Error("Unsupported Desktop build"); return connection; },
      }, async id => { if (config.failOpen) throw Error("Chat opener unavailable"); opened.push(id); });
      let shell;
      if (config.nativeNavigation) {
        globalThis.nativeNavigationBus = {
          handlers: new Map([["navigate-to-route", new Set()]]),
          dispatchHostMessage(message) {
            opened.push(message.path);
            if (config.failOpen) throw Error("Native router unavailable");
            if (config.ignoreOpen) return;
            setTimeout(() => {
              history.pushState({}, "", message.path);
              document.querySelector("main").textContent = "Opened scheduled chat";
            }, 10);
          },
        };
        const preload = document.createElement("link");
        preload.rel = "modulepreload";
        preload.href = "/assets/native-navigation.js";
        document.head.append(preload);
        installRendererSettingsLifecycle(window, {
          harnessSchedules: { getModelClient: () => client, connect: async () => connection,
            openThread: (id, signal) => openCodexLocalThread(id, signal) },
          openImportedThread: async () => { throw Error("Session import navigation must remain separate"); },
        });
        shell = window.__codexhostSettingsShellV1;
      } else {
        shell = mountRendererSettingsShell(createRendererSettingsPageRegistry([page]), document, rendererSettingsMessages(config.locale ?? "en"));
      }
      shell.openSettings(undefined, config.nativeNavigation ? "harness-schedules" : undefined);
      globalThis.scheduleFixture = { calls, opened, writes, shell, nativeItems: () => structuredClone(items), replaceItems: value => items = value, listCount: () => listCount, holdNextList: () => holdNextList = true, releaseList: () => releaseList?.(), releaseWrite: () => releaseWrite?.(), complete: () => complete?.(), aborted: () => aborted,
        consolePageIds: createDefaultRendererSettingsPages().map(p => p.id) };
    };
  `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "schedules-page-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
  loader: { ".css": "text", ".svg": "dataurl", ".png": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Schedule fixture bundle is missing");
async function setup(page: Page, config: Record<string, unknown> = {}) {
  await page.route("https://codexhost.test/**", (route) =>
    route.request().url().endsWith("/assets/native-navigation.js")
      ? route.fulfill({
          contentType: "text/javascript",
          body: "export const bus = globalThis.nativeNavigationBus;",
        })
      : route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body><main>Native chat</main></body></html>",
        }),
  );
  await page.goto("https://codexhost.test/");
  await page.evaluate(() => localStorage.setItem("ordinary-harness", "untouched"));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((config) => Reflect.get(globalThis, "setupSchedules")(config), config);
}
async function fill(page: Page) {
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await expect(page.getByLabel("Harness", { exact: true })).toBeEnabled();
  await page.getByLabel("Harness", { exact: true }).selectOption("pi");
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("pi-model");
  await page.getByLabel("Task", { exact: true }).fill("Harmless scheduled test");
}

test("uses explicit Harness and its current Model, retaining ordinary preferences and Console scope", async ({
  page,
}) => {
  await setup(page);
  await fill(page);
  await page.getByLabel("Harness", { exact: true }).selectOption("claude-code");
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("claude-code-model");
  await page.getByLabel("Repeat", { exact: true }).selectOption("weekly");
  await page.getByLabel("Day", { exact: true }).selectOption("5");
  await page.getByLabel("Local time", { exact: true }).fill("16:45");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Created.");
  const state = await page.evaluate(() => {
    const f = Reflect.get(globalThis, "scheduleFixture");
    return {
      calls: f.calls,
      ids: f.consolePageIds,
      preference: localStorage.getItem("ordinary-harness"),
    };
  });
  expect(state.calls).toEqual([
    {
      harnessId: "claude-code",
      model: { id: "claude-code-model" },
      prompt: "Harmless scheduled test",
      cwd: "",
      frequency: "weekly",
      weekday: 5,
      hour: 16,
      minute: 45,
    },
  ]);
  expect(state.ids).not.toContain("harness-schedules");
  expect(state.preference).toBe("untouched");
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").opened.length)).toBe(
    1,
  );
});

test("offers an optional directory only under Advanced", async ({ page }) => {
  await setup(page);
  await fill(page);
  const cwd = page.getByLabel("Working directory (optional)", { exact: true });
  await expect(cwd).not.toBeVisible();
  await page.getByText("Advanced", { exact: true }).click();
  await cwd.fill("/chosen/project");
  await cwd.blur();
  await expect(page.getByLabel("Model", { exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Created.");
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").calls[0].cwd)).toBe(
    "/chosen/project",
  );
});

test("prevents double submit and stops waiting on unmount", async ({ page }) => {
  await setup(page, { pending: true });
  await fill(page);
  await page.getByRole("button", { name: "Create", exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").calls.length)).toBe(
    1,
  );
  await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").shell.close());
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").aborted())).toBe(
    true,
  );
  await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").complete());
  await expect(page.getByRole("button", { name: "Open chat", exact: true })).toHaveCount(0);
});

test("disables incompatible Desktop services", async ({ page }) => {
  await setup(page, { unavailable: true });
  await expect(page.getByRole("status")).toContainText("Unsupported Desktop build");
  await expect(page.getByRole("button", { name: "New schedule", exact: true })).toHaveCount(0);
});

test("does not offer replay when the save result is unknown", async ({ page }) => {
  await setup(page, { outcome: "unknown" });
  await fill(page);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("unconfirmed");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeDisabled();
});

for (const scheme of ["light", "dark"] as const) {
  test(`fits narrow and desktop layouts in ${scheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [390, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await setup(page, { scheme });
      await fill(page);
      await page.getByText("Advanced", { exact: true }).click();
      const bounds = await page.getByLabel("Task", { exact: true }).boundingBox();
      if (!bounds) throw new Error("Task field is missing");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: info.outputPath(`schedule-${scheme}-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Create", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeInViewport();
    }
  });
}

const existingTask = {
  id: "existing",
  kind: "heartbeat",
  name: "检查项目进展",
  prompt: "总结项目本周的进展。",
  targetThreadId: "ffb4571e-d945-4f3e-8ce4-1db511796001",
  harnessId: "pi",
  status: "ACTIVE",
  rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=15;BYSECOND=0",
  notificationPolicy: "always",
};
const customTask = {
  ...existingTask,
  id: "custom",
  name: "整理资料",
  prompt: "整理最近记录并列出待办。",
  targetThreadId: "ffb4571e-d945-4f3e-8ce4-1db511796002",
  harnessId: "claude-code",
  status: "PAUSED",
  rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0;BYSECOND=0",
};

test("opens history and edits the original task using the same native store as the official list", async ({
  page,
}) => {
  await setup(page, { items: [existingTask] });
  const row = page.getByRole("article", { name: existingTask.name, exact: true });
  await row.getByRole("button", { name: "Open chat", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").opened)).toEqual([
    existingTask.targetThreadId,
  ]);
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Harness", { exact: true })).not.toBeVisible();
  await expect(page.getByLabel("Working directory (optional)", { exact: true })).not.toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Updated task");
  await page.getByLabel("Task", { exact: true }).fill("Updated body");
  await page.getByLabel("Repeat", { exact: true }).selectOption("weekly");
  await page.getByLabel("Day", { exact: true }).selectOption("5");
  await page.getByLabel("Local time", { exact: true }).fill("16:30");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("article", { name: "Updated task", exact: true })).toContainText(
    "Friday 16:30",
  );
  const state = await page.evaluate(() => {
    const f = Reflect.get(globalThis, "scheduleFixture");
    return { writes: f.writes, items: f.nativeItems(), creates: f.calls.length };
  });
  expect(state.writes).toHaveLength(1);
  expect(state.creates).toBe(0);
  expect(state.items[0]).toMatchObject({
    id: existingTask.id,
    targetThreadId: existingTask.targetThreadId,
    name: "Updated task",
    prompt: "Updated body",
    notificationPolicy: "always",
    model: null,
  });
});

test("edits only name/body for a complex RRULE without normalizing it", async ({ page }) => {
  await setup(page, { items: [customTask] });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByText(/This task uses a custom schedule/u)).toBeVisible();
  await expect(page.getByLabel("Local time", { exact: true })).not.toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Custom edited");
  await page.getByLabel("Task", { exact: true }).fill("Only body changed");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("article", { name: "Custom edited", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").nativeItems()[0].rrule),
  ).toBe(customTask.rrule);
});

test("pause/resume and confirmed deletion preserve the fixed chat binding", async ({ page }) => {
  await setup(page, { items: [existingTask] });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("Paused");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("Active");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm schedule deletion" });
  await expect(confirmation).toContainText("Chat history and workspace files stay");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        Reflect.get(globalThis, "scheduleFixture").writes.filter(
          (w: { method: string }) => w.method === "delete",
        ).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await confirmation.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(page.getByText("No schedules.", { exact: true })).toBeVisible();
  const writes = await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").writes);
  expect(writes.map((w: { method: string }) => w.method)).toEqual(["update", "update", "delete"]);
  expect(writes[0].params.targetThreadId).toBe(existingTask.targetThreadId);
  expect(writes[1].params.notificationPolicy).toBe(existingTask.notificationPolicy);
  expect(writes[2]).toEqual({ method: "delete", id: existingTask.id });
});

test("reentry reads current tasks and a stale refresh cannot overwrite the new page", async ({
  page,
}) => {
  await setup(page, { items: [existingTask] });
  await expect(page.getByRole("article", { name: existingTask.name, exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").holdNextList());
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Loading tasks");
  await page.evaluate(
    (item) => {
      const f = Reflect.get(globalThis, "scheduleFixture");
      f.shell.close();
      f.replaceItems([item]);
      f.shell.openSettings();
    },
    { ...existingTask, name: "Fresh native name" },
  );
  await expect(page.getByRole("article", { name: "Fresh native name", exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").releaseList());
  await expect(page.getByRole("article", { name: existingTask.name, exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").listCount())).toBe(3);
});

test("shows verified Codex and external tasks while retaining partial ownership failures", async ({
  page,
}) => {
  await setup(page, {
    items: [
      existingTask,
      customTask,
      {
        ...existingTask,
        id: "official",
        name: "Official task",
        targetThreadId: "ffb4571e-d945-4f3e-8ce4-1db511796003",
        official: true,
      },
    ],
    unreadableThread: customTask.targetThreadId,
  });
  await expect(page.getByRole("status")).toContainText("1 task(s) could not be verified");
  await expect(page.getByRole("article", { name: existingTask.name, exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Official task", exact: true })).toContainText(
    "Codex",
  );
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByText("No schedules.", { exact: true })).toHaveCount(0);
});

test("keeps keyboard focus visible between list actions", async ({ page }) => {
  await setup(page, { items: [existingTask] });
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  const create = page.getByRole("button", { name: "New schedule", exact: true });
  await refresh.focus();
  await page.keyboard.press("Tab");
  await expect(create).toBeFocused();
  expect(await create.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
});

test("keeps verified schedule management available when only creation is unavailable", async ({
  page,
}) => {
  await setup(page, {
    items: [existingTask],
    creationUnavailableReason: "scoped empty-chat/prewarm binding is not ready",
  });
  await expect(page.getByRole("article")).toBeVisible();
  await expect(page.getByRole("button", { name: "New schedule", exact: true })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("scoped empty-chat/prewarm binding");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("Paused");
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").calls.length)).toBe(
    0,
  );
});

test("opens and manages a Codex schedule without creating an external Thread", async ({ page }) => {
  const codexTask = {
    ...existingTask,
    id: "official-task",
    name: "Official task",
    targetThreadId: "ffb4571e-d945-4f3e-8ce4-1db511796003",
    official: true,
  };
  await setup(page, { items: [codexTask] });
  const row = page.getByRole("article", { name: "Official task", exact: true });
  await expect(row).toContainText("Codex");
  await row.getByRole("button", { name: "Open chat", exact: true }).click();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Official task edited");
  await page.getByLabel("Task", { exact: true }).fill("Edited by codexhost");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const edited = page.getByRole("article", { name: "Official task edited", exact: true });
  await expect(edited).toContainText("Codex");
  await edited.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("Paused");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("group", { name: "Confirm schedule deletion" })
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(page.getByText("No schedules.", { exact: true })).toBeVisible();
  const state = await page.evaluate(() => {
    const f = Reflect.get(globalThis, "scheduleFixture");
    return { opened: f.opened, writes: f.writes, creates: f.calls.length };
  });
  expect(state.opened).toEqual([codexTask.targetThreadId]);
  expect(state.creates).toBe(0);
  expect(state.writes[0].params).toMatchObject({
    id: codexTask.id,
    targetThreadId: codexTask.targetThreadId,
    prompt: "Edited by codexhost",
  });
  expect(state.writes.at(-1)).toEqual({ method: "delete", id: codexTask.id });
});

test("an unknown update is not replayed and returning to the list reads its actual outcome", async ({
  page,
}) => {
  await setup(page, { items: [existingTask], unknownWrite: true });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Committed before error");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("unconfirmed");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").writes.length)).toBe(
    1,
  );
  await page.getByRole("button", { name: "Back to list", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Committed before error", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").writes.length)).toBe(
    1,
  );
});

test.describe("Chinese review", () => {
  test.use({ locale: "zh-CN" });
  for (const scheme of ["light", "dark"] as const) {
    test(`Chinese mixed list, edit and delete review screenshots in ${scheme}`, async ({
      page,
    }, info) => {
      for (const width of [1100, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await setup(page, {
          locale: "zh-CN",
          scheme,
          items: [
            existingTask,
            customTask,
            {
              ...existingTask,
              id: "codex-review",
              name: "官方日报：每周整理项目进度与待办事项",
              targetThreadId: "ffb4571e-d945-4f3e-8ce4-1db511796003",
              official: true,
            },
          ],
        });
        await expect(page.getByRole("article")).toHaveCount(3);
        await page.screenshot({
          path: info.outputPath(`mixed-list-zh-${scheme}-${width}.png`),
          fullPage: true,
        });
        const bounds = await page.getByRole("article").first().boundingBox();
        if (!bounds) throw new Error("Task row missing");
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await page.setViewportSize({ width: 1100, height: 900 });
      await page
        .getByRole("article", { name: existingTask.name, exact: true })
        .getByRole("button", { name: "修改", exact: true })
        .click();
      await expect(page.getByLabel("名称", { exact: true })).toHaveValue(existingTask.name);
      await page.screenshot({
        path: info.outputPath(`schedule-edit-zh-${scheme}-1100.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "返回列表", exact: true }).click();
      await page
        .getByRole("article", { name: existingTask.name, exact: true })
        .getByRole("button", { name: "删除", exact: true })
        .click();
      await expect(page.getByRole("group", { name: "确认删除日程" })).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`schedule-delete-confirmation-zh-${scheme}-1100.png`),
        fullPage: true,
      });
    });
  }
});

test("editing only a name preserves the original basic RRULE text", async ({ page }) => {
  const rrule = "RRULE:BYMINUTE=15;FREQ=DAILY;BYSECOND=0;INTERVAL=1;BYHOUR=9";
  await setup(page, { items: [{ ...existingTask, rrule }] });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Name only");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("article", { name: "Name only", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").writes[0].params.rrule),
  ).toBe(rrule);
});

test("a write result arriving after unmount does not replace the reopened list", async ({
  page,
}) => {
  await setup(page, { items: [existingTask], pendingUpdate: true });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Late update");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").writes.length))
    .toBe(1);
  await page.evaluate(() => {
    const f = Reflect.get(globalThis, "scheduleFixture");
    f.shell.close();
    f.shell.openSettings();
  });
  await expect(page.getByRole("article", { name: existingTask.name, exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").releaseWrite());
  await expect(page.getByRole("article", { name: "Late update", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("article", { name: "Late update", exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").writes.length)).toBe(
    1,
  );
});

const officialEveryDay = "RRULE:FREQ=WEEKLY;BYHOUR=10;BYMINUTE=15;BYDAY=SU,MO,TU,WE,TH,FR,SA";
test("official daily 10:15 is shown and its time remains editable", async ({ page }, info) => {
  for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1100, height: 900 });
    await setup(page, {
      locale: "zh-CN",
      scheme,
      items: [{ ...existingTask, rrule: officialEveryDay }],
    });
    await expect(page.getByRole("article")).toContainText("每天 10:15");
    await page.getByRole("button", { name: "修改", exact: true }).click();
    await expect(page.getByLabel("重复", { exact: true })).toHaveValue("daily");
    await expect(page.getByLabel("本地时间", { exact: true })).toHaveValue("10:15");
    await page.screenshot({
      path: info.outputPath(`official-daily-edit-zh-${scheme}.png`),
      fullPage: true,
    });
    await page.getByLabel("本地时间", { exact: true }).fill("11:20");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("article")).toContainText("每天 11:20");
    const state = await page.evaluate(() => {
      const f = Reflect.get(globalThis, "scheduleFixture");
      return { writes: f.writes, creates: f.calls.length };
    });
    expect(state.creates).toBe(0);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].params).toMatchObject({
      id: existingTask.id,
      targetThreadId: existingTask.targetThreadId,
      rrule: "FREQ=DAILY;BYHOUR=11;BYMINUTE=20;BYSECOND=0",
    });
  }
});

test("official daily RRULE stays verbatim when only the task body changes", async ({ page }) => {
  await setup(page, { items: [{ ...existingTask, rrule: officialEveryDay }] });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Local time", { exact: true })).toBeVisible();
  await page.getByLabel("Task", { exact: true }).fill("Changed body only");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("Daily 10:15");
  const written = await page.evaluate(
    () => Reflect.get(globalThis, "scheduleFixture").writes[0].params,
  );
  expect(written.prompt).toBe("Changed body only");
  expect(written.rrule).toBe(officialEveryDay);
});

test("open chat failure makes the previously hidden status visible", async ({ page }) => {
  await setup(page, { items: [existingTask], failOpen: true });
  await expect(page.getByRole("article")).toBeVisible();
  await expect(page.getByRole("status", { includeHidden: true })).toBeHidden();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Open this chat from the sidebar.");
});

for (const official of [false, true]) {
  test(`opens a ${official ? "Codex" : "Harness"} scheduled chat through the native router without a sidebar row`, async ({
    page,
  }) => {
    await setup(page, { items: [{ ...existingTask, official }], nativeNavigation: true });
    await expect(page.locator("[data-app-action-sidebar-thread-row]")).toHaveCount(0);
    await expect(page.locator(".codexhost-settings-page")).toBeVisible();
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(page).toHaveURL(`https://codexhost.test/local/${existingTask.targetThreadId}`);
    await expect(page.locator(".codexhost-settings-page")).toBeHidden();
    await expect(page.locator("body > main")).toHaveText("Opened scheduled chat");
    const state = await page.evaluate(() => {
      const f = Reflect.get(globalThis, "scheduleFixture");
      return { routes: f.opened, writes: f.writes, creates: f.calls.length };
    });
    expect(state).toEqual({
      routes: [`/local/${existingTask.targetThreadId}`],
      writes: [],
      creates: 0,
    });
  });
}

test("keeps schedules open and reports a native navigation failure", async ({ page }) => {
  await setup(page, { items: [existingTask], nativeNavigation: true, failOpen: true });
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Open this chat from the sidebar.");
  await expect(page.locator(".codexhost-settings-page")).toBeVisible();
  await expect(page).toHaveURL("https://codexhost.test/");
});

test("does not report an unacknowledged native navigation as success", async ({ page }) => {
  await setup(page, { items: [existingTask], nativeNavigation: true, ignoreOpen: true });
  await page.clock.install();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").opened.length))
    .toBe(1);
  await expect(page.locator(".codexhost-settings-page")).toBeVisible();
  await page.clock.runFor(5_100);
  await expect(page.getByRole("status")).toHaveText("Open this chat from the sidebar.");
  await expect(page.locator(".codexhost-settings-page")).toBeVisible();
  await expect(page).toHaveURL("https://codexhost.test/");
});
