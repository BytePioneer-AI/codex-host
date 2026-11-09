import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import type { WebUiExtensionsState } from "@codexhost/shared-contracts";
import { startServer } from "../support/server.ts";

it("opens project links separately, hides missing links and keeps extension details usable at phone width", async (t) => {
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    [],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state: WebUiExtensionsState = {
    safeMode: false,
    loadedIds: [],
    extensions: [
      {
        id: "github-theme",
        projectUrl: "https://github.com/example/theme",
        meta: {
          title: { en: "GitHub theme", zh: "GitHub 主题" },
          description: { en: "A theme with a long plugin description. ".repeat(12) },
          icon: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>').toString("base64")}`,
        },
      },
      {
        id: "web-theme",
        projectUrl: "https://theme.example/docs",
        meta: { icon: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}` },
      },
      { id: "@long-package-name/theme-without-a-public-project-link" },
    ].map((entry) => ({
      ...entry,
      name: entry.id,
      version: "1.0.0",
      format: "dsh",
      enabledTargets: [],
      supportedTargets: ["web"],
      source: `/installed/${entry.id}`,
      installedAt: "2026-01-01T00:00:00Z",
    })),
  };
  await page.route("**/api/codexhost/uiExtensions/list", (route) =>
    route.fulfill({ json: { result: { ok: true, value: state } } }),
  );
  await context.route("https://github.com/example/theme", (route) =>
    route.fulfill({ body: "GitHub project" }),
  );
  await context.route("https://theme.example/docs", (route) =>
    route.fulfill({ body: "Project homepage" }),
  );
  await page.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Interface extensions", exact: true }).click();
  const section = page.locator("[data-web-extensions]");
  const github = section.locator('[data-web-extension="github-theme"]');
  const generic = section.locator('[data-web-extension="web-theme"]');
  const missing = section.locator("[data-web-extension]").last();
  await github.getByRole("link", { name: "GitHub", exact: true }).waitFor();
  await github.getByRole("button", { name: "GitHub theme", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-web-extension="github-theme"] img');
    return img instanceof HTMLImageElement && img.naturalWidth === 16;
  });
  await generic.locator("img").waitFor({ state: "detached" });
  assert.equal(await missing.locator("img").count(), 0);
  assert.equal(await generic.getByRole("link", { name: "Project website" }).count(), 1);
  assert.equal(await missing.getByRole("link").count(), 0);
  assert.equal(await section.getByRole("button", { name: "Uninstall", exact: true }).count(), 0);
  for (const [row, label, destination] of [
    [github, "GitHub", "https://github.com/example/theme"],
    [generic, "Project website", "https://theme.example/docs"],
  ] as const) {
    const [project] = await Promise.all([
      page.waitForEvent("popup"),
      row.getByRole("link", { name: label, exact: true }).click(),
    ]);
    await project.waitForLoadState();
    assert.equal(project.url(), destination);
    await project.close();
    assert.equal(await section.locator("[data-web-extension-detail]").count(), 0);
  }
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ colorScheme: width === 1280 ? "light" : "dark" });
    assert.equal(
      await section.evaluate((root) => {
        const controls = root.querySelectorAll("button, a");
        return [...controls].every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth;
        });
      }),
      true,
      `extension controls fit ${width}px`,
    );
  }
  await github.getByRole("button", { name: "GitHub theme", exact: true }).click();
  let detail = section.locator("[data-web-extension-detail]");
  await detail.getByRole("heading", { name: "GitHub theme", exact: true }).waitFor();
  await detail.getByText("github-theme", { exact: true }).waitFor();
  assert.ok(
    ((await detail.innerText()) ?? "").includes(
      "A theme with a long plugin description. ".repeat(12).trim(),
    ),
  );
  await detail.getByText("Source: /installed/github-theme", { exact: true }).waitFor();
  assert.equal(await detail.getByRole("link", { name: "GitHub" }).count(), 1);
  await detail.getByRole("button", { name: "Uninstall", exact: true }).click();
  await detail.getByText("Its running instance will stop", { exact: false }).waitFor();
  await detail.getByRole("button", { name: "Cancel", exact: true }).click();
  await section.getByRole("button", { name: "Interface extensions", exact: true }).click();
  await missing.getByRole("button").click();
  detail = section.locator("[data-web-extension-detail]");
  assert.equal(await detail.getByRole("link").count(), 0);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page
    .getByRole("group", { name: "Language / 语言", exact: true })
    .getByRole("button", { name: "中文", exact: true })
    .click();
  await page.getByRole("button", { name: "界面扩展", exact: true }).click();
  await github.getByRole("button", { name: "GitHub 主题", exact: true }).waitFor();
  assert.equal(
    await github.getByText("A theme with a long plugin description.", { exact: false }).count(),
    1,
  );
  assert.deepEqual(errors, []);
});
