import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { withDiscovery } from "../support/harness-commands.ts";

for (const [width, trigger] of [
  [390, "@"],
  [390, "#"],
  [1280, "@"],
  [1280, "#"],
] as const) {
  it(
    `selects workspace file mentions in threads and drafts via ${trigger} at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const workspace = mkdtempSync(join(tmpdir(), "file-mentions-"));
      t.after(() => rmSync(workspace, { recursive: true, force: true }));
      mkdirSync(join(workspace, "my docs"));
      mkdirSync(join(workspace, "src", "deep"), { recursive: true });
      writeFileSync(join(workspace, "src", "deep", "config.ts"), "nested config");
      writeFileSync(join(workspace, "README.md"), "root file");
      writeFileSync(join(workspace, "my docs", "read me.md"), "nested file");
      const host = new FakeChHost();
      withDiscovery(host);
      host.add("file-mentions", workspace, "File mentions");
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
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const target = new URL(url);
      target.searchParams.set("session", "file-mentions");
      await page.goto(target.href);
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      const composer = page.locator("[data-composer-input]");
      const menu = page.getByRole("listbox", { name: "Trigger suggestions", exact: true });
      assert.equal(
        await page.getByRole("button", { name: "Add files or run commands", exact: true }).count(),
        0,
      );
      await composer.fill("/");
      await menu.getByRole("option", { name: /^Model\b/ }).waitFor();
      await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
      await menu.getByText("Interface actions", { exact: true }).waitFor();
      assert.equal(await menu.getByText("Delegation Agents", { exact: true }).count(), 0);
      assert.equal(await menu.getByText("Workspace files", { exact: true }).count(), 0);
      await composer.fill(`Look at ${trigger}`);
      await menu.getByRole("option", { name: "README.md", exact: true }).waitFor();
      await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
      const menuText = await menu.innerText();
      const sections = ["Delegation Agents", "Native commands", "Skills", "Workspace files"];
      assert.deepEqual(
        [...sections].sort((a, b) => menuText.indexOf(a) - menuText.indexOf(b)),
        sections,
      );
      assert.equal(await menu.getByRole("option", { name: /^Model\b/ }).count(), 0);
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(
            process.env.CODEXHOST_TEST_SCREENSHOTS,
            `file-mentions-${width}-${trigger === "@" ? "at" : "hash"}.png`,
          ),
        });
      }
      await composer.press("Escape");
      await menu.waitFor({ state: "hidden" });
      assert.equal(await composer.innerText(), `Look at ${trigger}`);
      await composer.fill(`Find ${trigger}cfg`);
      await menu.getByRole("option", { name: "src/deep/config.ts", exact: true }).click();
      assert.equal((await composer.innerText()).trim(), "Find @src/deep/config.ts");
      await composer.fill(`Look at ${trigger}read`);
      await menu.getByRole("option", { name: "README.md", exact: true }).click();
      assert.equal((await composer.innerText()).trim(), "Look at @README.md");

      await composer.fill(`Inspect ${trigger}my`);
      const directory = menu.getByRole("option", { name: "my docs/ Browse folder", exact: true });
      await directory.waitFor();
      if (width < 600)
        await directory.getByRole("button", { name: "Browse folder", exact: true }).tap();
      else {
        await directory.hover();
        await composer.press("Tab");
      }
      await menu.getByRole("option", { name: "my docs/read me.md", exact: true }).waitFor();
      await composer.press("Enter");
      assert.equal((await composer.innerText()).trim(), 'Inspect @"my docs/read me.md"');
      assert.equal(
        host.requests.some((request) => ["thread/start", "turn/start"].includes(request.method)),
        false,
      );
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText('CH response: Inspect @"my docs/read me.md"', { exact: true }).waitFor();

      const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true }).last();
      if (await sidebar.isVisible()) await sidebar.click();
      const project = page
        .locator('[data-row-key^="workspace:"]')
        .filter({ hasText: basename(workspace) });
      await project.hover();
      await page
        .getByRole("button", { name: `New session in ${basename(workspace)}`, exact: true })
        .click();
      await page.getByText("What should we build today?", { exact: true }).waitFor();
      await composer.fill(`Review ${trigger}read`);
      await menu.getByRole("option", { name: "README.md", exact: true }).click();
      assert.equal((await composer.innerText()).trim(), "Review @README.md");
      assert.equal(
        host.requests.some((request) => request.method === "thread/start"),
        false,
      );
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("CH response: Review @README.md", { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    },
  );
}
