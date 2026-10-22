import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

/** Rows the browser lists under `[role="tree"]`, in DOM order. */
async function rowKeys(page: Page): Promise<(string | null)[]> {
  return page
    .locator('[role="tree"] [data-row-key]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-key")));
}

for (const mobile of [false, true]) {
  it(
    `pinned, workspaces and recents sections fold independently (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      host.add("alpha-session", "/computer/alpha", "Alpha conversation");
      host.add("beta-session", "/computer/beta", "Beta conversation");
      host.add("loose-session", "/computer/loose", "Loose conversation", false);
      host.pinnedIds = ["alpha-session"];
      const debug = await startFakeChDebugger(host);
      t.after(() => debug.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
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
      if (mobile)
        await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();

      const pinned = page.locator('[data-row-key="section:pinned"]');
      const workspaces = page.locator('[data-row-key="section:workspaces"]');
      const recents = page.locator('[data-row-key="workspace:"]');
      await pinned.waitFor();
      await workspaces.waitFor();
      await recents.waitFor();
      assert.equal(await pinned.getAttribute("aria-expanded"), "true");
      assert.equal(await workspaces.getAttribute("aria-expanded"), "true");
      assert.equal(await recents.getAttribute("aria-expanded"), "true");
      assert.equal(
        await page.locator('[data-row-key^="workspace:"]').count(),
        3,
        "two Workspaces plus Recents",
      );

      await pinned.click();
      assert.equal(await pinned.getAttribute("aria-expanded"), "false");
      assert.equal(
        await page.locator('[data-row-key="session:alpha-session"]').count(),
        0,
        "folding Pinned takes its rows out without unpinning them",
      );

      await workspaces.click();
      assert.equal(await workspaces.getAttribute("aria-expanded"), "false");
      assert.equal(
        await page.locator('[data-row-key^="workspace:"]').count(),
        1,
        "folding the Workspace section leaves Recents reachable",
      );

      await recents.click();
      assert.equal(await recents.getAttribute("aria-expanded"), "false");
      assert.deepEqual(await rowKeys(page), ["section:pinned", "section:workspaces", "workspace:"]);

      // Folds persist: a reload restores the folded sidebar, not the default view.
      await page.reload();
      await page.getByText("Native Model", { exact: true }).waitFor();
      if (mobile)
        await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
      await pinned.waitFor();
      assert.equal(await pinned.getAttribute("aria-expanded"), "false");
      assert.equal(await workspaces.getAttribute("aria-expanded"), "false");
      assert.equal(await recents.getAttribute("aria-expanded"), "false");

      // Unfolding restores each section's own rows.
      await pinned.click();
      await workspaces.click();
      await recents.click();
      await page.locator('[data-row-key="session:alpha-session"]').waitFor();
      const restored = await rowKeys(page);
      assert.deepEqual(restored.slice(0, 3), [
        "section:pinned",
        "session:alpha-session",
        "section:workspaces",
      ]);
      assert.equal(
        restored.filter((key) => key?.startsWith("workspace:")).length,
        3,
        "both Workspaces and Recents render again",
      );
      assert.ok(restored.includes("recent:loose-session"));
      assert.deepEqual(errors, []);
    },
  );
}

it(
  "paged lists only page forward and refolding returns to the default window",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    for (let i = 0; i < 8; i++)
      host.add(`project-${i}-session`, `/computer/project-${i}`, `Project ${i} conversation`);
    for (let i = 0; i < 8; i++)
      host.add(`alpha-${i}`, "/computer/alpha", `Alpha conversation ${i}`);
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor();

    const workspaceRows = () =>
      page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll('[role="tree"] [data-row-key^="workspace:"]'),
          ).filter((row) => row.getAttribute("data-row-key") !== "workspace:").length,
      );
    const section = page.locator('[data-row-key="section:workspaces"]');
    const workspaceWindow = page.locator('[data-row-key="overflow:workspaces"]');
    await section.waitFor();
    assert.equal(await workspaceRows(), 5, "the Workspace list starts at its default window");
    assert.equal(await workspaceWindow.count(), 1);

    await workspaceWindow.click();
    assert.equal(await workspaceRows(), 9, "expanding reveals every Workspace");
    assert.equal(
      await workspaceWindow.count(),
      0,
      "a fully revealed list offers no collapse control",
    );

    // Folding the section and reopening it restores the default window.
    await section.click();
    await section.click();
    assert.equal(await workspaceRows(), 5);
    assert.equal(await workspaceWindow.count(), 1);

    // The same rule holds for one Workspace's own Session rows.
    await workspaceWindow.click();
    const alpha = page
      .locator('[role="tree"] [data-row-key^="workspace:"]')
      .filter({ hasText: /^alpha$/ });
    await alpha.click();
    const alphaRows = page.locator('[data-row-key^="session:alpha-"]');
    await alphaRows.first().waitFor();
    assert.equal(await alphaRows.count(), 5);
    // A group's paging row shares the Workspace id with its header row.
    const alphaKey = (await alpha.getAttribute("data-row-key"))?.replace("workspace:", "");
    const alphaOverflow = page.locator(`[data-row-key="overflow:${String(alphaKey)}"]`);
    await alphaOverflow.click();
    assert.equal(await alphaRows.count(), 8);
    assert.equal(await alphaOverflow.count(), 0, "a fully paged group offers no collapse control");
    assert.equal(
      await page.locator('[data-row-key^="overflow:"]').count(),
      1,
      "only Recents still pages forward",
    );

    await alpha.click();
    assert.equal(await alphaRows.count(), 0, "folding the group takes its rows out");
    await alpha.click();
    assert.equal(await alphaRows.count(), 5, "reopening the group starts from the default window");
    assert.deepEqual(errors, []);
  },
);
