import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function shot(page: Page, name: string) {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await page.screenshot({ path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`) });
}

it(
  "startup draft preparation does not request a workspace or override an explicit pick",
  { timeout: 60_000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "ch-startup-gui-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const project = join(home, "picked-project");
    mkdirSync(project);
    const host = new FakeChHost();
    host.add("existing-project-session", project);
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      { environment: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const preparing = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const settled = Promise.withResolvers<undefined>();
    t.after(() => release.resolve(undefined));
    let firstCreate = true;
    await page.route("**/api/session/create", async (route) => {
      if (!firstCreate) return route.continue();
      firstCreate = false;
      preparing.resolve(undefined);
      await release.promise;
      await route.continue();
      settled.resolve(undefined);
    });
    await page.goto(url);
    await preparing.promise;
    const editor = page.locator("[data-input-scroll] [data-placeholder]");
    assert.equal(await editor.getAttribute("data-placeholder"), "Preparing conversation…");
    assert.equal(await editor.getAttribute("aria-haspopup"), null);
    await shot(page, "startup-preparing");
    await page.locator("[data-input-scroll]").click();
    assert.equal(await page.getByRole("menu").count(), 0);
    await shot(page, "startup-input-no-picker");

    const chip = page.getByRole("button", { name: "Choose workspace", exact: true });
    await chip.click();
    await page.getByRole("menuitem", { name: "picked-project", exact: true }).click();
    await page.getByText("Native Model", { exact: true }).waitFor();
    await chip.getByText("picked-project", { exact: true }).waitFor();
    const selected = await page
      .locator("[data-conversation-content]")
      .getAttribute("data-conversation-session");
    const initialResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/create"),
    );
    release.resolve(undefined);
    await settled.promise;
    await initialResponse;
    assert.equal(
      await page.locator("[data-conversation-content]").getAttribute("data-conversation-session"),
      selected,
    );
    await editor.fill("Draft kept after startup");
    assert.equal(await editor.textContent(), "Draft kept after startup");
    await shot(page, "startup-ready-picked-workspace");
    assert.deepEqual(errors, []);
    assert.equal(
      host.requests.some((request) => request.method === "thread/start"),
      false,
    );
  },
);

for (const mobile of [false, true]) {
  it(
    `Recents includes every workspace newest-first; its draft can keep, select or clear a workspace (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const home = mkdtempSync(join(tmpdir(), "ch-recents-gui-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const project = join(home, "existing-project");
      mkdirSync(project);
      const host = new FakeChHost();
      const projectThread = host.add("project-session", project, "Existing project conversation");
      projectThread.updatedAt = 1000;
      host.add(
        "other-project-session",
        join(home, "other-project"),
        "Other project conversation",
      ).updatedAt = 5000;
      host.add(
        "loose-old",
        join(home, "generated-old"),
        "Older loose conversation",
        false,
      ).updatedAt = 2000;
      host.add(
        "loose-new",
        join(home, "generated-new"),
        "Newest loose conversation",
        false,
      ).updatedAt = 4000;
      host.add(
        "loose-middle",
        join(home, "generated-middle"),
        "Middle loose conversation",
        false,
      ).updatedAt = 3000;
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
        { environment: { ...process.env, HOME: home, USERPROFILE: home } },
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      const content = page.locator("[data-conversation-content]");
      const chip = content.getByRole("button", { name: "Choose workspace", exact: true });
      await chip.getByText("No workspace", { exact: true }).waitFor();
      assert.equal(
        await page.locator('[contenteditable="true"]').getAttribute("aria-disabled"),
        null,
      );
      assert.equal(
        host.requests.some((request) => request.method === "thread/start"),
        false,
        "opening a draft must not create a canonical Thread",
      );
      const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (mobile) await openSidebar.last().click();
      const recent = page.locator('[data-sidebar-group=""]');
      const recentHeader = recent.getByRole("treeitem", { name: "Recents", exact: true });
      await recentHeader.waitFor();
      assert.equal(
        await page.locator('[data-row-key^="session:draft-"]').count(),
        0,
        "an unsent draft stays in the composer instead of entering the sidebar",
      );
      if (mobile) {
        const createBounds = await recentHeader
          .getByRole("button", { name: "New session", exact: true })
          .boundingBox();
        assert.ok(createBounds && createBounds.width >= 44 && createBounds.height >= 44);
      }
      assert.equal(
        await recentHeader.locator("svg").first().getAttribute("viewBox"),
        "0 0 16 16",
        "Recents has a chevron, not a folder",
      );
      const recentRows = recent.locator('[data-row-key^="recent:"]');
      const order = () =>
        recentRows.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
      assert.deepEqual(await order(), [
        "recent:other-project-session",
        "recent:loose-new",
        "recent:loose-middle",
        "recent:loose-old",
        "recent:project-session",
      ]);
      assert.equal(
        await recentRows
          .first()
          .evaluate((row) => Number.parseFloat(getComputedStyle(row).paddingInlineStart)),
        8,
      );
      await shot(page, `recents-${mobile ? "touch" : "desktop"}-list`);
      await page.getByRole("button", { name: "View options", exact: true }).click();
      await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
      assert.deepEqual(
        await order(),
        [
          "recent:other-project-session",
          "recent:loose-new",
          "recent:loose-middle",
          "recent:loose-old",
          "recent:project-session",
        ],
        "project order preferences do not change Recents",
      );
      projectThread.updatedAt = 6000;
      await page.reload();
      await page.getByText("Native Model", { exact: true }).waitFor();
      if (mobile) await openSidebar.last().click();
      assert.deepEqual(await order(), [
        "recent:project-session",
        "recent:other-project-session",
        "recent:loose-new",
        "recent:loose-middle",
        "recent:loose-old",
      ]);
      const projectHeading = page.getByRole("treeitem").filter({ hasText: /^existing-project$/u });
      if ((await projectHeading.getAttribute("aria-expanded")) === "false")
        await projectHeading.click();
      await page.locator('[data-row-key="session:project-session"]').click();
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      if (mobile) await openSidebar.last().click();
      assert.equal(
        await recent
          .locator('[data-row-key="recent:project-session"]')
          .getAttribute("aria-current"),
        "page",
        "the project and Recents rows open the same canonical conversation",
      );
      const rowKeys = await page
        .locator("[data-row-key]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
      assert.equal(new Set(rowKeys).size, rowKeys.length, "every displayed row has a unique key");
      await recentHeader.getByRole("button", { name: "New session", exact: true }).click();
      await chip.getByText("No workspace", { exact: true }).waitFor();
      assert.equal(
        await page.locator('[data-row-key^="session:draft-"]').count(),
        0,
        "opening another unsent draft does not add a session row",
      );
      await page
        .locator('[contenteditable="true"]')
        .pressSequentially("Keep this draft while choosing");
      await chip.click();
      await page.getByRole("menuitem", { name: "No workspace", exact: true }).waitFor();
      await shot(page, `recents-${mobile ? "touch" : "desktop"}-picker`);
      await page.getByRole("menuitem", { name: "existing-project", exact: true }).click();
      await chip.getByText("existing-project", { exact: true }).waitFor();
      assert.match(await page.locator('[contenteditable="true"]').innerText(), /Keep this draft/u);
      await chip.click();
      await page.getByRole("menuitem", { name: "No workspace", exact: true }).click();
      await chip.getByText("No workspace", { exact: true }).waitFor();
      assert.match(await page.locator('[contenteditable="true"]').innerText(), /Keep this draft/u);
      await shot(page, `recents-${mobile ? "touch" : "desktop"}-unselected`);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page
        .getByText("CH response: Keep this draft while choosing", { exact: true })
        .waitFor();
      const creation = host.requests.find((request) => request.method === "thread/start");
      assert.ok(creation);
      assert.equal(
        "cwd" in creation.params,
        false,
        "do not inherit the current or most recent project",
      );
      assert.deepEqual(creation.params.projectlessWorkspace, {
        prompt: "Keep this draft while choosing",
      });
      const created = [...host.threads.values()].find((row) => row.id.startsWith("canonical-"));
      assert.ok(created);
      if (mobile) await openSidebar.last().click();
      await recent.locator(`[data-row-key="recent:${created.id}"]`).waitFor();
      assert.equal(
        await page
          .getByRole("treeitem")
          .filter({ hasText: /^codexhost-projectless-fixture$/u })
          .count(),
        0,
        "execution directory is not registered as a workspace",
      );
      await shot(page, `recents-${mobile ? "touch" : "desktop"}-sent`);
      assert.deepEqual(errors, []);
    },
  );
}

it(
  "the conversation picker creates and selects a real new workspace through the existing directory flow",
  { timeout: 60_000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "ch-new-workspace-gui-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const host = new FakeChHost();
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      { environment: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor();
    const chip = page.getByRole("button", { name: "Choose workspace", exact: true });
    await chip.click();
    await page.getByRole("menuitem", { name: "Add workspace…", exact: true }).click();
    await page.getByRole("dialog", { name: "Select Workspace Directory", exact: true }).waitFor();
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByRole("textbox", { name: "Folder name", exact: true }).fill("created-workspace");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await chip.getByText("created-workspace", { exact: true }).waitFor();
    assert.ok(existsSync(join(home, "created-workspace")));
    assert.equal(host.requests.filter((request) => request.method === "thread/start").length, 0);
    await shot(page, "recents-new-workspace-selected");
    await page.locator('[contenteditable="true"]').pressSequentially("Work in my new directory");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("CH response: Work in my new directory", { exact: true }).waitFor();
    const start = host.requests.find((request) => request.method === "thread/start");
    assert.ok(start);
    assert.equal(start.params.cwd, join(home, "created-workspace"));
    assert.equal("projectlessWorkspace" in start.params, false);
    await shot(page, "recents-new-workspace-sent");
    assert.deepEqual(errors, []);
  },
);
