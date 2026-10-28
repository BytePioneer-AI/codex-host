import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createDefaultRendererSettingsPages } from "./packages/renderer-extension/src/settings/pages.ts";
      import { installRendererSettingsLifecycle } from "./packages/renderer-extension/src/renderer-settings-lifecycle.ts";
      import { openCodexSchedules } from "./packages/renderer-extension/src/codex-schedule-navigation.ts";
      globalThis.setupSchedules = (config = {}) => {
        const opened = [], operations = [];
        let releaseNavigation;
        const main = document.querySelector("main");
        const setRoute = (element, pathname, active) => {
          element.setAttribute("data-app-shell-active-page", String(active));
          element.__reactFiber$fixture = { memoizedProps: {}, return: {
            memoizedProps: { value: { location: { pathname }, navigationType: "PUSH" } },
          } };
        };
        if (config.memoryNavigation) setRoute(main, "/", true);
        if (config.backgroundPath) {
          const background = document.createElement("div");
          setRoute(background, config.backgroundPath, false);
          document.body.append(background);
        }
        globalThis.nativeNavigationBus = {
          handlers: new Map([["navigate-to-route", new Set()]]),
          dispatchHostMessage(message) {
            opened.push(message);
            if (config.failOpen) throw Error("Native router unavailable");
            if (config.ignoreOpen) return;
            const arrive = () => {
              const destination = config.redirect ?? message.path;
              if (config.memoryNavigation) setRoute(main, destination, true);
              else history.pushState({}, "", destination);
              main.textContent = "Official destination: " + destination;
            };
            if (config.holdNavigation) releaseNavigation = arrive;
            else setTimeout(arrive, 10);
          },
        };
        // Navigating must not read or write the task store, or inspect a Harness.
        globalThis.nativeSchedulesServices = {
          localAutomations: Object.fromEntries(["list", "create", "update", "delete"].map(method =>
            [method, () => { operations.push(method); throw Error("Task store must not be used"); }])),
        };
        const preload = document.createElement("link");
        preload.rel = "modulepreload";
        preload.href = "/assets/native-navigation.js";
        document.head.append(preload);
        const lifecycle = installRendererSettingsLifecycle(window, {
          harnessSchedules: { openSchedules: signal => openCodexSchedules(signal) },
          openImportedThread: async () => { throw Error("Session import navigation must remain separate"); },
        });
        const shell = window.__codexhostSettingsShellV1;
        shell.openSettings(undefined, config.direct ? "harness-schedules" : "about");
        globalThis.scheduleFixture = {
          opened, operations, shell,
          consolePageIds: createDefaultRendererSettingsPages().map(p => p.id),
          allowNavigation: () => { config.failOpen = false; config.ignoreOpen = false; },
          releaseNavigation: () => releaseNavigation?.(),
          dispose: () => lifecycle.dispose(),
        };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "schedules-shortcut-fixture.ts",
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
if (!bundle) throw new Error("Schedule shortcut fixture bundle is missing");

async function setup(page: Page, config: Record<string, unknown> = {}) {
  await page.route("https://codexhost.test/**", (route) =>
    route.request().url().endsWith("/assets/native-navigation.js")
      ? route.fulfill({
          contentType: "text/javascript",
          body: "export const bus = globalThis.nativeNavigationBus; export const services = globalThis.nativeSchedulesServices;",
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
async function act(page: Page, method: string, arg?: unknown) {
  return page.evaluate(
    ({ method, arg }) => Reflect.get(globalThis, "scheduleFixture")[method](arg),
    {
      method,
      arg,
    },
  );
}
async function calls(page: Page) {
  return page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").opened);
}
const settings = (page: Page) => page.locator(".codexhost-settings-page");
const schedules = (page: Page) => page.getByRole("button", { name: "Schedules", exact: true });

for (const memoryNavigation of [false, true]) {
  for (const redirect of ["/automations", "/scheduled"]) {
    test(`schedule sidebar redirects to ${redirect} with ${memoryNavigation ? "memory" : "history"} routing`, async ({
      page,
    }) => {
      await setup(page, { memoryNavigation, redirect, holdNavigation: true });
      await expect(schedules(page)).toBeVisible();
      await schedules(page).click();
      await expect
        .poll(() => calls(page))
        .toEqual([{ type: "navigate-to-route", path: "/automations" }]);
      await expect(settings(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "New schedule", exact: true })).toHaveCount(0);
      await expect(page.getByRole("article")).toHaveCount(0);
      await expect(page.getByLabel("Harness", { exact: true })).toHaveCount(0);
      await act(page, "releaseNavigation");
      await expect(settings(page)).toBeHidden();
      await expect(page.locator("body > main")).toHaveText(`Official destination: ${redirect}`);
      await expect(page).toHaveURL(`https://codexhost.test${memoryNavigation ? "/" : redirect}`);
      expect(
        await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").operations),
      ).toEqual([]);
      expect(
        await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").consolePageIds),
      ).not.toContain("harness-schedules");
      expect(await page.evaluate(() => localStorage.getItem("ordinary-harness"))).toBe("untouched");
    });
  }
}

test("directly opening the schedules settings destination also redirects", async ({ page }) => {
  await setup(page, { direct: true, memoryNavigation: true });
  await expect(settings(page)).toBeHidden();
  expect(await calls(page)).toEqual([{ type: "navigate-to-route", path: "/automations" }]);
  await expect(page.locator("body > main")).toHaveText("Official destination: /automations");
});

test("failed navigation keeps settings open and offers only explicit retry", async ({ page }) => {
  await setup(page, { failOpen: true });
  await schedules(page).click();
  await expect(page.getByRole("status")).toContainText(
    "Could not open the official schedules page",
  );
  await expect(settings(page)).toBeVisible();
  expect(await calls(page)).toHaveLength(1);
  await act(page, "allowNavigation");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(settings(page)).toBeHidden();
  expect(await calls(page)).toHaveLength(2);
});

for (const backgroundPath of [undefined, "/automations", "/scheduled"]) {
  test(`does not acknowledge ignored navigation or a retained inactive destination (${backgroundPath ?? "none"})`, async ({
    page,
  }) => {
    await setup(page, { memoryNavigation: true, ignoreOpen: true, backgroundPath });
    await page.clock.install();
    await schedules(page).click();
    await expect.poll(() => calls(page)).toHaveLength(1);
    await page.clock.runFor(5_100);
    await expect(page.getByRole("status")).toContainText(
      "Could not open the official schedules page",
    );
    await expect(settings(page)).toBeVisible();
    await expect(page.locator("body > main")).toHaveText("Native chat");
  });
}

test("leaving the shortcut cancels its wait without closing another settings page later", async ({
  page,
}) => {
  await setup(page, { memoryNavigation: true, holdNavigation: true });
  await page.clock.install();
  await schedules(page).click();
  await expect.poll(() => calls(page)).toHaveLength(1);
  await page.getByRole("button", { name: "About", exact: true }).click();
  await act(page, "releaseNavigation");
  await page.clock.runFor(5_100);
  await expect(settings(page)).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "scheduleFixture").shell.activePageId),
  ).toBe("about");
  await expect(
    page.getByText("Could not open the official schedules page", { exact: false }),
  ).toHaveCount(0);
});
