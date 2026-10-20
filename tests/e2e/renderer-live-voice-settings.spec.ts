import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createLiveVoicePage } from "./packages/renderer-extension/src/console/pages/live-voice.ts";
      import { ConsoleState } from "./packages/renderer-extension/src/console/state.ts";
      import { consoleMessages } from "./packages/renderer-extension/src/console/messages.ts";
      import { createAppearanceSettingsPage } from "./packages/renderer-extension/src/settings/appearance-page.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      globalThis.setup = (mode) => {
        const content = document.querySelector("main");
        let dispose;
        if (mode === "console") {
          const state = new ConsoleState();
          const mount = () => { dispose = createLiveVoicePage(consoleMessages("en"), state).mount({content}); };
          mount();
          globalThis.fixture = {refresh: () => state.refresh(), remount: () => {dispose(); mount();}, dispose: () => {dispose(); content.textContent = "left";}};
        } else {
          if (mode === "injected") globalThis.__codexhostCpaLiveVoiceHookV1 = {enabled:true, auditedDesktopVersion:"26.1013.40934",auditedAppInitialAsset:"fixture.js"};
          dispose = createAppearanceSettingsPage(rendererSettingsMessages("en"), () => null, async () => {throw new Error("console unavailable");}).mount({content});
          globalThis.fixture = {dispose, dispatchChat: () => {localStorage.setItem("codexhost.chat-live-voice.v1", "0"); dispatchEvent(new Event("codexhost:chat-live-voice-changed"));}};
        }
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "live-voice-settings-fixture.ts",
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
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Missing voice settings fixture");

async function setup(page: Page, mode = "console") {
  await page.route("http://voice-settings.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main></main>",
    }),
  );
  await page.goto("http://voice-settings.test/");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((value) => Reflect.get(globalThis, "setup")(value), mode);
}

function overview(inject = true, envOverride: string | null = null) {
  return {
    liveVoice: { inject, envOverride },
    launchAvailable: true,
    summary: { state: "running" },
  };
}

test("loads before editing, saves the toggle, and retains restart guidance after remount", async ({
  page,
}) => {
  let saved = true;
  const writes: unknown[] = [];
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview(saved) }));
  await page.route("**/api/live-voice-inject", (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    saved = body.inject;
    return route.fulfill({ json: { inject: saved, envOverride: null } });
  });
  await setup(page);
  const toggle = page.getByRole("switch", { name: "Enable voice integration", exact: true });
  await expect(toggle).toBeDisabled();
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  await expect(toggle).toBeEnabled();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(writes).toEqual([{ inject: false }]);
  await page.evaluate(() => Reflect.get(globalThis, "fixture").remount());
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("status")).toContainText("Active setting is unknown");
  await expect(page.getByRole("button", { name: /relaunch/i })).toHaveCount(0);
});

test("reports save failure, restores saved state and permits retry", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview() }));
  await page.route("**/api/live-voice-inject", (route) =>
    route.fulfill({ status: 500, json: { error: "setting is read-only" } }),
  );
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  const toggle = page.getByRole("switch");
  await toggle.click();
  await expect(page.getByRole("alert")).toHaveText("setting is read-only");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview(false) }));
  await page.route("**/api/live-voice-inject", (route) =>
    route.fulfill({ json: { inject: false, envOverride: null } }),
  );
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("disables editing while offline or while an environment override applies", async ({
  page,
}) => {
  let offline = false;
  await page.route("**/api/overview", (route) =>
    route.fulfill(
      offline ? { status: 503, json: { error: "offline" } } : { json: overview(false, "0") },
    ),
  );
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  await expect(page.getByRole("switch")).toBeDisabled();
  await expect(
    page.getByText("CODEXHOST_CPA_LIVE_VOICE on this process overrides the saved file."),
  ).toBeVisible();
  offline = true;
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  await expect(page.getByRole("switch")).toBeDisabled();
});

test("does not redraw a page left while its save is in flight", async ({ page }) => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview() }));
  await page.route("**/api/live-voice-inject", async (route) => {
    await gate;
    await route.fulfill({ json: { inject: false, envOverride: null } });
  });
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  const request = page.waitForRequest("**/api/live-voice-inject");
  await page.getByRole("switch").click();
  await request;
  await page.evaluate(() => Reflect.get(globalThis, "fixture").dispose());
  const response = page.waitForResponse("**/api/overview");
  finish();
  await response;
  await expect(page.locator("main")).toHaveText("left");
});

test("Desktop separates gateway defaults, persists them and releases listeners", async ({
  page,
}) => {
  await setup(page, "injected");
  const work = page.getByRole("combobox", { name: "Work voice", exact: true });
  const chat = page.getByRole("combobox", { name: "Chat voice", exact: true });
  await expect(work).toHaveValue("gateway");
  await expect(chat).toHaveValue("native");
  await chat.selectOption("gateway");
  await work.selectOption("native");
  expect(
    await page.evaluate(() => [
      localStorage.getItem("codexhost.cpa-live-voice.v1"),
      localStorage.getItem("codexhost.chat-live-voice.v1"),
    ]),
  ).toEqual(["0", "1"]);
  await page.evaluate(() => Reflect.get(globalThis, "fixture").dispatchChat());
  await expect(chat).toHaveValue("native");
  await chat.selectOption("gateway");
  await page.evaluate(() => {
    const f = Reflect.get(globalThis, "fixture");
    f.dispose();
    f.dispatchChat();
  });
  await expect(chat).toHaveValue("gateway");
  await page.reload();
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "setup")("injected"));
  await expect(work).toHaveValue("native");
  await expect(chat).toHaveValue("native");
});

test("Desktop disables gateway controls without injection and reports console-opening failure", async ({
  page,
}) => {
  await setup(page, "disabled");
  await expect(page.getByRole("combobox", { name: "Work voice", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Chat voice", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Open console", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "console unavailable" })).toBeVisible();
});

test("shows saved versus active settings and confirms a real restart request", async ({ page }) => {
  let inject = true;
  let activeInject = true;
  let phase = "idle";
  const writes: unknown[] = [];
  await page.route("**/api/overview", (route) =>
    route.fulfill({
      json: {
        ...overview(inject),
        liveVoice: { inject, envOverride: null, activeInject },
        restart: { phase, error: null },
      },
    }),
  );
  await page.route("**/api/live-voice-inject", (route) => {
    inject = route.request().postDataJSON().inject;
    return route.fulfill({ json: { inject, envOverride: null } });
  });
  await page.route("**/api/restart", (route) => {
    writes.push(route.request().postDataJSON());
    phase = "restarting";
    return route.fulfill({ status: 202, json: { phase, error: null } });
  });
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  await expect(page.getByRole("status")).toContainText("Saved setting is active");
  await page.getByRole("switch").uncheck();
  await expect(page.getByRole("status")).toContainText("Saved — restart required");
  await page.getByRole("button", { name: "Restart codexhost", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "may interrupt" })).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Restart codexhost", exact: true }).click();
  await page.getByRole("button", { name: "Restart now", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restart codexhost", exact: true })).toBeDisabled();
  expect(writes).toEqual([{ confirm: true }]);
  activeInject = false;
  phase = "succeeded";
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  await expect(
    page.getByRole("status").filter({ hasText: "Saved setting is active" }),
  ).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Restart complete" })).toBeVisible();
});

test("shows restart API errors without claiming completion", async ({ page }) => {
  await page.route("**/api/overview", (route) => route.fulfill({ json: overview() }));
  await page.route("**/api/restart", (route) =>
    route.fulfill({ status: 500, json: { error: "restart unavailable" } }),
  );
  await setup(page);
  await page.evaluate(() => Reflect.get(globalThis, "fixture").refresh());
  await page.getByRole("button", { name: "Restart codexhost", exact: true }).click();
  await page.getByRole("button", { name: "Restart now", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("restart unavailable");
  await expect(page.getByText("Restart complete.", { exact: false })).toHaveCount(0);
});
