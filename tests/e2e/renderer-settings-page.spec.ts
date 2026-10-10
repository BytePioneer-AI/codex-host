import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupSettingsPage = () => {
        const messages = rendererSettingsMessages("en");
        const page = (id, label) => ({
          id,
          label,
          icon: "settings",
          mount({ content }) {
            const heading = document.createElement("h1");
            heading.textContent = label;
            const modal = document.createElement("dialog");
            modal.className = "page-modal";
            modal.textContent = "Nested";
            content.append(heading, modal);
          },
        });
        const registry = createRendererSettingsPageRegistry([
          page("connections", "Connections"),
          page("appearance", "General"),
        ]);
        const events = [];
        const shell = mountRendererSettingsShell(registry, document, messages, {
          onOpenChange: (open) => events.push(open),
        });
        // Model the native distinction: reselecting Home opens "/", while
        // returning from another destination restores the previous conversation.
        const nativeNavigations = [];
        history.replaceState({}, "", "/thread/settings-test");
        document.body.addEventListener("click", (event) => {
          const destination = event.target.closest("[data-sidebar-destination]");
          if (!destination) return;
          const id = destination.getAttribute("data-sidebar-destination");
          const wasCurrent = destination.getAttribute("aria-current") === "page";
          nativeNavigations.push(id);
          for (const button of document.querySelectorAll("[data-sidebar-destination]")) {
            button.toggleAttribute("data-selected", button === destination);
            if (button === destination) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
          }
          history.pushState({}, "", id === "builtin:home"
            ? (wasCurrent ? "/" : "/thread/settings-test")
            : "/plugins");
        });
        globalThis.settingsFixture = { shell, events, nativeNavigations };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-page-e2e-entry.ts",
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
if (!bundle) throw new Error("Settings page fixture bundle missing");

// Mirrors the Codex rail contract: ghost buttons show selection through
// [data-selected]::before and expose the current destination via aria-current.
const nativeShell = `<!doctype html><html><head><style>
  body { margin: 0; display: flex; height: 100vh; }
  nav { width: 56px; margin-top: 40px; display: flex; flex-direction: column; gap: 4px; }
  .rail-button { position: relative; width: 36px; height: 36px; border: 0; background: none;
    --button-text-color: rgb(120, 120, 120); color: var(--button-text-color); }
  .rail-button::before { content: ""; position: absolute; inset: 0; opacity: 0; background: #ddd; }
  .rail-button[data-selected] { color: rgb(0, 0, 0); }
  .rail-button[data-selected]::before { opacity: 1; }
  main { flex: 1; }
</style></head><body>
  <nav data-app-navigation-rail="true">
    <button class="rail-button" data-sidebar-destination="builtin:home" data-selected="" aria-current="page">H</button>
    <button class="rail-button" data-sidebar-destination="builtin:plugins">P</button>
  </nav>
  <main>Native content</main>
</body></html>`;

async function setup(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.route("http://localhost/settings-page", (route) =>
    route.fulfill({ contentType: "text/html", body: nativeShell }),
  );
  await page.goto("http://localhost/settings-page");
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupSettingsPage")());
}

function openSettings(page: Page, pageId?: string) {
  return page.evaluate(
    (id) => Reflect.get(globalThis, "settingsFixture").shell.openSettings(undefined, id),
    pageId,
  );
}

function fixtureState(page: Page) {
  return page.evaluate(() => {
    const { shell, events, nativeNavigations } = Reflect.get(globalThis, "settingsFixture");
    const home = document.querySelector('[data-sidebar-destination="builtin:home"]');
    const rail = document.querySelector("nav[data-app-navigation-rail]");
    if (!home || !rail) throw new Error("Native rail fixture missing");
    return {
      open: shell.open,
      events: [...events],
      nativeNavigations: [...nativeNavigations],
      pathname: location.pathname,
      railMarked: rail.hasAttribute("data-codexhost-settings-open"),
      railStyles: document.querySelectorAll("[data-codexhost-settings-rail-style]").length,
      homeHighlight: getComputedStyle(home, "::before").opacity,
      homeSelected: home.hasAttribute("data-selected"),
    };
  });
}

test("covers the content beside the rail and hides native selection without editing it", async ({
  page,
}) => {
  await setup(page);
  expect(await openSettings(page)).toBe(true);

  const surface = page.locator(".codexhost-settings-page");
  await expect(surface).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const railBox = await page.locator("nav[data-app-navigation-rail]").boundingBox();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox?.x).toBeCloseTo((railBox?.x ?? 0) + (railBox?.width ?? 0), 0);
  expect(surfaceBox?.y).toBeCloseTo(railBox?.y ?? 0, 0);
  expect((surfaceBox?.x ?? 0) + (surfaceBox?.width ?? 0)).toBeCloseTo(1200, 0);

  expect(await fixtureState(page)).toMatchObject({
    open: true,
    events: [true],
    railMarked: true,
    railStyles: 1,
    homeHighlight: "0",
    homeSelected: true,
  });

  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
  expect(await fixtureState(page)).toMatchObject({
    open: false,
    events: [true, false],
    railMarked: false,
    railStyles: 0,
    homeHighlight: "1",
  });
});

for (const activation of ["click", "Enter", "Space"] as const) {
  test(`Home dismisses settings without resetting the conversation (${activation})`, async ({
    page,
  }) => {
    await setup(page);
    await openSettings(page, "appearance");
    const home = page.locator('[data-sidebar-destination="builtin:home"]');
    if (activation === "click") await home.click();
    else {
      await home.focus();
      await page.keyboard.press(activation);
    }

    await expect(page.locator(".codexhost-settings-page")).toBeHidden();
    expect(await fixtureState(page)).toMatchObject({
      open: false,
      events: [true, false],
      pathname: "/thread/settings-test",
      nativeNavigations: [],
      railMarked: false,
      railStyles: 0,
      homeSelected: true,
    });

    // The interception belongs only to the open settings page.
    await home.click();
    expect(await fixtureState(page)).toMatchObject({
      pathname: "/",
      nativeNavigations: ["builtin:home"],
    });
  });
}

test("Home from settings over another destination uses native conversation restoration", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-sidebar-destination="builtin:plugins"]').click();
  await openSettings(page);
  await page.locator('[data-sidebar-destination="builtin:home"]').click();

  await expect(page.locator(".codexhost-settings-page")).toBeHidden();
  expect(await fixtureState(page)).toMatchObject({
    pathname: "/thread/settings-test",
    nativeNavigations: ["builtin:plugins", "builtin:home"],
  });
});

for (const selection of ["missing", "ambiguous"] as const) {
  test(`does not intercept Home with ${selection} native selection`, async ({ page }) => {
    await setup(page);
    await page.evaluate((selection) => {
      if (selection === "missing") {
        document
          .querySelector('[data-sidebar-destination="builtin:home"]')
          ?.removeAttribute("aria-current");
      } else {
        document
          .querySelector('[data-sidebar-destination="builtin:plugins"]')
          ?.setAttribute("aria-current", "page");
      }
    }, selection);
    await openSettings(page);
    await page.locator('[data-sidebar-destination="builtin:home"]').click();

    await expect(page.locator(".codexhost-settings-page")).toBeHidden();
    expect(await fixtureState(page)).toMatchObject({ nativeNavigations: ["builtin:home"] });
  });
}

test("does not intercept Home after the native location changed", async ({ page }) => {
  await setup(page);
  await openSettings(page);
  // pushState alone emits no popstate; click before another observer can close settings.
  await page.evaluate(() => {
    history.pushState({}, "", "/thread/another");
    document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')?.click();
  });

  await expect(page.locator(".codexhost-settings-page")).toBeHidden();
  expect(await fixtureState(page)).toMatchObject({ nativeNavigations: ["builtin:home"] });
});

test("does not intercept a modified Home click", async ({ page }) => {
  await setup(page);
  await openSettings(page);
  await page.locator('[data-sidebar-destination="builtin:home"]').click({ modifiers: ["Shift"] });

  await expect(page.locator(".codexhost-settings-page")).toBeHidden();
  expect(await fixtureState(page)).toMatchObject({ nativeNavigations: ["builtin:home"] });
});

test("yields to a native rail destination", async ({ page }) => {
  await setup(page);
  await openSettings(page, "appearance");

  // The rail stays interactive: no modal blocks the native click.
  await page.locator('[data-sidebar-destination="builtin:plugins"]').click();
  await expect(page.locator(".codexhost-settings-page")).toBeHidden();
  expect(await fixtureState(page)).toMatchObject({
    open: false,
    railMarked: false,
    pathname: "/plugins",
    nativeNavigations: ["builtin:plugins"],
  });
});

test("yields when native navigation changes the current destination", async ({ page }) => {
  await setup(page);
  await openSettings(page);

  await page.evaluate(() => {
    document
      .querySelector('[data-sidebar-destination="builtin:home"]')
      ?.removeAttribute("aria-current");
    document
      .querySelector('[data-sidebar-destination="builtin:plugins"]')
      ?.setAttribute("aria-current", "page");
  });
  await expect(page.locator(".codexhost-settings-page")).toBeHidden();
});

test("yields to browser history navigation", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => history.pushState({}, "", "#thread"));
  await openSettings(page);

  await page.evaluate(() => history.back());
  await expect(page.locator(".codexhost-settings-page")).toBeHidden();
});

test("lets a page-owned modal handle Escape first", async ({ page }) => {
  await setup(page);
  await openSettings(page);

  await page.locator(".page-modal").evaluate((dialog: HTMLDialogElement) => dialog.showModal());
  await page.keyboard.press("Escape");
  await expect(page.locator(".page-modal")).toBeHidden();
  await expect(page.locator(".codexhost-settings-page")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".codexhost-settings-page")).toBeHidden();
});
