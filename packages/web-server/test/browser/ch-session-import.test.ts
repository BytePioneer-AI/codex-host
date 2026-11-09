import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { expect } from "@playwright/test";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { SessionImportHost } from "../support/session-import.ts";

async function fixture(t: TestContext, width = 1280) {
  const host = new SessionImportHost();
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    ["--ch-cdp", debug.endpoint],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 600 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await openImport(page);
  return { host, page, errors };
}

async function openImport(page: Page) {
  const entry = page.getByRole("button", { name: "Import sessions", exact: true });
  if (!(await entry.isVisible()))
    await page.getByRole("button", { name: "Open sidebar", exact: true }).last().click();
  await entry.click();
  await page.getByRole("heading", { name: "Import sessions", exact: true }).waitFor();
}

function row(page: Page, title: string) {
  return page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });
}

for (const width of [390, 1280])
  it(
    `imports native history, paginates and continues the canonical Thread at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { host, page, errors } = await fixture(t, width);
      await expect(
        row(page, "Native history 0").getByRole("button", { name: "Import", exact: true }),
      ).toBeEnabled();
      await expect(page.getByText("Activity unknown", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Running in another client", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Idle", { exact: true })).toHaveCount(0);
      await expect(
        page.getByText(
          "Close these sessions in other native clients before importing to avoid concurrent writes.",
        ),
      ).toHaveCount(0);
      await page.getByRole("tab", { name: "CH Harness", exact: true }).click();
      await expect(row(page, "Native history 1")).toBeVisible();
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(row(page, "Native history 24")).toBeVisible();
      await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
      const search = page.getByRole("searchbox", { name: "Search by title or folder" });
      await search.fill("native-24");
      await expect(page.getByText("1–1 of 1", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
      await search.fill("");
      await page.getByRole("combobox", { name: "Sessions per page" }).selectOption("50");
      await expect(row(page, "Native history 24")).toBeVisible();
      await page.getByRole("tab", { name: "Pi", exact: true }).click();
      await row(page, "Pi same native identity")
        .getByRole("button", { name: "Import", exact: true })
        .click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      const imported = host.requests.filter((request) =>
        request.method.endsWith("session-import/import"),
      );
      assert.deepEqual(
        imported.map((request) => request.params),
        [{ harnessId: "pi", nativeSessionId: "native-2" }],
      );
      await page.reload();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      await page
        .getByRole("textbox", {
          name: "Message or run a task, / commands, @ files or sessions",
          exact: true,
        })
        .fill("continue imported history");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("CH response: continue imported history", { exact: true }).waitFor();
      assert.equal(host.requests.filter((request) => request.method === "thread/start").length, 0);
      assert.equal(
        host.requests.find((request) => request.method === "turn/start")?.params.threadId,
        "import-pi-native-2",
      );
      await openImport(page);
      await page.getByRole("tab", { name: "Pi", exact: true }).click();
      await expect(page.getByText("No sessions found.", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "CH Harness", exact: true }).click();
      await expect(row(page, "Native history 2")).toBeVisible();
      assert.deepEqual(errors, []);
    },
  );

it(
  "submits imports without a client activity gate and displays actual Host errors",
  { timeout: 45_000 },
  async (t) => {
    const { host, page, errors } = await fixture(t);
    await row(page, "Native history 0")
      .getByRole("button", { name: "Import", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not import this session: Native Session is busy",
    );
    assert.deepEqual(
      host.requests
        .filter((request) => request.method.endsWith("session-import/import"))
        .map((request) => request.params),
      [{ harnessId: "fake", nativeSessionId: "native-0" }],
    );
    await expect(
      row(page, "Native history 0").getByRole("button", { name: "Import", exact: true }),
    ).toBeEnabled();
    assert.deepEqual(errors, []);
  },
);

it(
  "retains a committed import across catalog failure and retries opening without resubmitting",
  { timeout: 45_000 },
  async (t) => {
    const { host, page, errors } = await fixture(t);
    await row(page, "Native history 2").waitFor();
    host.failCatalogAfterImport = true;
    await row(page, "Native history 2")
      .getByRole("button", { name: "Import", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Session imported, but could not open it.");
    await row(page, "Native history 2").getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Session imported, but could not open it.");
    host.failCatalogAfterImport = false;
    await row(page, "Native history 2").getByRole("button", { name: "Open", exact: true }).click();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    assert.equal(
      host.requests.filter((request) => request.method.endsWith("session-import/import")).length,
      1,
    );
    assert.deepEqual(errors, []);
  },
);

it(
  "locks import controls and ignores a committed response after the page is left",
  { timeout: 45_000 },
  async (t) => {
    const { host, page, errors } = await fixture(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    host.beforeImport = () => gate;
    await row(page, "Native history 2")
      .getByRole("button", { name: "Import", exact: true })
      .click();
    await expect(page.getByRole("tab", { name: "Pi", exact: true })).toBeDisabled();
    await expect(page.getByRole("searchbox")).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Sessions per page" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Refresh sessions", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .filter({ hasText: "New Session" })
      .click();
    await expect(page.getByRole("heading", { name: "Import sessions", exact: true })).toHaveCount(
      0,
    );
    release();
    await expect.poll(() => host.mappings.size).toBe(1);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("existing CH answer", { exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
  },
);

it(
  "recovers from malformed wire responses and rejected imports without losing the page",
  { timeout: 45_000 },
  async (t) => {
    const { host, page, errors } = await fixture(t);
    await row(page, "Native history 2").waitFor();
    for (const [method, value] of [
      ["importSources", []],
      ["importCandidates", { items: [], total: 0 }],
    ] as const) {
      const pattern = `**/api/codexhost/${method}`;
      await page.route(pattern, (route) =>
        route.fulfill({ json: { result: { ok: true, value } } }),
      );
      await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Could not load sessions:");
      await page.unroute(pattern);
      await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(row(page, "Native history 2")).toBeVisible();
    }
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await row(page, "Native history 24").waitFor();
    host.candidates.set("fake", host.candidates.get("fake")?.slice(0, 3) ?? []);
    await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
    await expect(page.getByText("1–3 of 3", { exact: true })).toBeVisible();
    host.importError = "Native session disappeared before import";
    await row(page, "Native history 2")
      .getByRole("button", { name: "Import", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not import this session: Native session disappeared before import",
    );
    assert.equal(host.mappings.size, 0);
    delete host.importError;
    await row(page, "Native history 2")
      .getByRole("button", { name: "Import", exact: true })
      .click();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  },
);

it("rejects stale search responses from another Harness", { timeout: 45_000 }, async (t) => {
  const { host, page, errors } = await fixture(t);
  await row(page, "Native history 2").waitFor();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  host.beforeList = async (params) => {
    if (params.harnessId === "fake" && params.query === "native-2") {
      entered();
      await gate;
    }
  };
  await page.getByRole("searchbox").fill("native-2");
  await started;
  await page.getByRole("tab", { name: "Pi", exact: true }).click();
  await expect(row(page, "Pi same native identity")).toBeVisible();
  release();
  await page.waitForLoadState("networkidle");
  await expect(row(page, "Pi same native identity")).toBeVisible();
  await expect(row(page, "Native history 2")).toHaveCount(0);
  assert.deepEqual(errors, []);
});
