import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (executablePath) test.use({ launchOptions: { executablePath } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createVoiceSettingsPage } from "./packages/renderer-extension/src/settings/voice-page.ts";
      import { createAppearanceSettingsPage } from "./packages/renderer-extension/src/settings/appearance-page.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import css from "./packages/renderer-extension/src/settings/shell.css";
      import tailwind from "./packages/renderer-extension/src/settings/tailwind.css";
      const host = document.createElement("div"); host.style.colorScheme = "dark"; document.body.append(host);
      const shadow = host.attachShadow({mode:"open"});
      const style = document.createElement("style"); style.textContent = tailwind + css; shadow.append(style);
      const surface=document.createElement("section"); surface.className="settings-page";
      const content=document.createElement("main"); content.className="settings-page__content";surface.append(content);shadow.append(surface);
      globalThis.setup = (mode) => {
        const page = mode === "general" ? createAppearanceSettingsPage(rendererSettingsMessages("en")) : createVoiceSettingsPage("en", async input => {
          const response = await fetch("/api/voice-settings", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(input)});
          const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
        }, {desktop: mode === "desktop"});
        const dispose = page.mount({content});
        globalThis.fixture = {dispose: () => {dispose?.(); content.textContent = "left";}};
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "voice-page-fixture.ts",
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
const settings = {
  chatExperience: "chatgpt",
  chatConnection: "desktop",
  workConnection: "desktop",
  inject: true,
};
function initial() {
  return {
    settings: { ...settings },
    initialized: true,
    revision: "1",
    activeInject: true,
    envOverride: null,
    activeEnvOverride: null,
    routesActive: true,
    activeCall: false,
    gatewayReady: true,
    restartAvailable: true,
    restart: { phase: "idle", error: null },
  };
}
async function setup(page: Page, mode = "console") {
  await page.route("http://voice-settings.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body style="margin:0;background:#202020"></body>',
    }),
  );
  await page.goto("http://voice-settings.test/");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((value) => Reflect.get(globalThis, "setup")(value), mode);
}

test("draft edits and Cancel do not save; Apply persists three distinct Chat routes", async ({
  page,
}) => {
  const state = initial();
  const writes: unknown[] = [];
  await page.route("**/api/voice-settings", (route) => {
    const input = route.request().postDataJSON();
    if (input.operation === "set") {
      writes.push(input);
      state.settings = input.settings;
      state.revision = "2";
    }
    return route.fulfill({ json: state });
  });
  await setup(page, "desktop");
  const experience = page.getByRole("combobox", { name: "Voice experience", exact: true });
  const connection = page.getByRole("combobox", { name: "Codex connection", exact: true });
  await expect(experience).toHaveValue("chatgpt");
  await expect(connection).toBeDisabled();
  await experience.selectOption("codex");
  await expect(connection).toBeEnabled();
  await connection.selectOption("gateway");
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(experience).toHaveValue("chatgpt");
  expect(writes).toEqual([]);
  await experience.selectOption("codex");
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No pending changes");
  expect(writes).toEqual([
    { operation: "set", revision: "1", settings: { ...settings, chatExperience: "codex" } },
  ]);
});

test("both settings surfaces load the shared saved values", async ({ page, context }) => {
  const state = initial();
  await context.route("**/api/voice-settings", (route) => {
    const input = route.request().postDataJSON();
    if (input.operation === "set") {
      state.settings = input.settings;
      state.revision = "2";
    }
    return route.fulfill({ json: state });
  });
  await setup(page, "desktop");
  await page
    .getByRole("combobox", { name: "Voice connection", exact: true })
    .selectOption("gateway");
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No pending changes");
  const consolePage = await context.newPage();
  await setup(consolePage);
  await expect(
    consolePage.getByRole("combobox", { name: "Voice connection", exact: true }),
  ).toHaveValue("gateway");
});

test("integration changes use one confirmed apply and restart action", async ({ page }) => {
  const state = initial();
  const operations: string[] = [];
  await page.route("**/api/voice-settings", (route) => {
    const input = route.request().postDataJSON();
    if (input.operation !== "get") operations.push(input.operation);
    if (input.operation === "set") {
      state.settings = input.settings;
      state.revision = "2";
    }
    if (input.operation === "restart") state.restart.phase = "restarting";
    return route.fulfill({ json: state });
  });
  await setup(page);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("switch", { name: "Enable voice integration", exact: true }).uncheck();
  await page.getByRole("button", { name: "Apply and restart codexhost", exact: true }).click();
  expect(operations).toEqual([]);
  await expect(page.getByText(/This may interrupt running tasks/)).toBeVisible();
  await page.getByRole("button", { name: "Apply and restart", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Restarting codexhost");
  expect(operations).toEqual(["set", "restart"]);
});

test("reports a failed restart as saved but inactive and supports retry", async ({ page }) => {
  const state = initial();
  let attempts = 0;
  await page.route("**/api/voice-settings", (route) => {
    const input = route.request().postDataJSON();
    if (input.operation === "set") {
      state.settings = input.settings;
      state.revision = "2";
    }
    if (input.operation === "restart") {
      attempts++;
      return route.fulfill({ status: 500, json: { error: "restart unavailable" } });
    }
    return route.fulfill({ json: state });
  });
  await setup(page);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("switch").uncheck();
  await page.getByRole("button", { name: "Apply and restart codexhost", exact: true }).click();
  await page.getByRole("button", { name: "Apply and restart", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("restart unavailable");
  await expect(page.getByRole("status")).toContainText("Saved — restart required");
  expect(state.settings.inject).toBe(false);
  expect(attempts).toBe(1);
  await expect(page.getByText("Restart complete", { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Apply and restart codexhost", exact: true }),
  ).toBeEnabled();
});

test("guards active calls and locks only integration under an environment override", async ({
  page,
}) => {
  const state = initial();
  state.activeCall = true;
  state.envOverride = "1" as never;
  await page.route("**/api/voice-settings", (route) => route.fulfill({ json: state }));
  await setup(page);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.getByRole("switch")).toBeDisabled();
  await page.getByRole("combobox", { name: "Voice experience", exact: true }).selectOption("codex");
  await expect(page.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("End your voice call");
});

test("save failure keeps the draft and permits retry", async ({ page }) => {
  const state = initial();
  await page.route("**/api/voice-settings", (route) =>
    route.request().postDataJSON().operation === "set"
      ? route.fulfill({ status: 500, json: { error: "read-only setting" } })
      : route.fulfill({ json: state }),
  );
  await setup(page);
  await page.getByRole("combobox", { name: "Voice experience", exact: true }).selectOption("codex");
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("read-only setting");
  await expect(page.getByRole("combobox", { name: "Voice experience", exact: true })).toHaveValue(
    "codex",
  );
  await expect(page.getByRole("button", { name: "Apply changes", exact: true })).toBeEnabled();
});

test("rejects a stale edit without overwriting another window", async ({ page }) => {
  const state = initial();
  let writes = 0;
  await page.route("**/api/voice-settings", (route) => {
    if (route.request().postDataJSON().operation === "set") writes++;
    return route.fulfill({ json: state });
  });
  await setup(page);
  await page.getByRole("combobox", { name: "Voice experience", exact: true }).selectOption("codex");
  state.revision = "other";
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Settings changed in another window");
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Voice experience", exact: true })).toHaveValue(
    "chatgpt",
  );
});

test("General no longer contains voice preferences", async ({ page }) => {
  await setup(page, "general");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByText("Hide Codex usage warning", { exact: true })).toBeVisible();
});

test("console saves integration for a later launch while Desktop is stopped", async ({ page }) => {
  const state = { ...initial(), activeInject: null, restartAvailable: false, routesActive: null };
  const operations: string[] = [];
  await page.route("**/api/voice-settings", (route) => {
    const input = route.request().postDataJSON();
    if (input.operation !== "get") operations.push(input.operation);
    if (input.operation === "set") {
      state.settings = input.settings;
      state.revision = "2";
    }
    return route.fulfill({ json: state });
  });
  await setup(page);
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("switch").uncheck();
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("active setting is unknown");
  expect(operations).toEqual(["set"]);
});

for (const width of [1280, 430])
  test(`Voice page fits upstream layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.route("**/api/voice-settings", (route) => route.fulfill({ json: initial() }));
    await setup(page);
    await expect(
      page.getByRole("combobox", { name: "Voice experience", exact: true }),
    ).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`voice-${width}.png`), fullPage: true });
  });

test("leaving while Apply checks current state prevents a later save or restart", async ({
  page,
}) => {
  let getCount = 0;
  const mutations: string[] = [];
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/voice-settings", async (route) => {
    const input = route.request().postDataJSON();
    if (input.operation === "get") {
      getCount++;
      if (getCount === 2) await gate;
    } else mutations.push(input.operation);
    await route.fulfill({ json: initial() });
  });
  await setup(page);
  await page.getByRole("combobox", { name: "Voice experience", exact: true }).selectOption("codex");
  const checking = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/voice-settings") && request.postDataJSON()?.operation === "get",
  );
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await checking;
  await page.evaluate(() => Reflect.get(globalThis, "fixture").dispose());
  const completed = page.waitForResponse("**/api/voice-settings");
  finish();
  await completed;
  await expect(page.locator("main")).toHaveText("left");
  expect(mutations).toEqual([]);
});
