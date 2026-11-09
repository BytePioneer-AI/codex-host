import assert from "node:assert/strict";
import { it } from "node:test";
import { discoveryBrowser } from "../support/discovery-browser.ts";

for (const width of [390, 1280])
  it(
    `the plus menu puts delegation last and inserts targets without submitting at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { host, page, composer, menu, open, attach, writeMethods } = await discoveryBrowser(
        t,
        width,
        true,
      );
      const expectedTargets = ["Alphaalpha-agent", "Twinfake", "Twinother"];
      const targets = menu.locator('[role="option"][id*="codexhost-delegation"]');
      const plus = page.getByRole("button", { name: "Add files or run commands", exact: true });
      const search = page.getByRole("combobox", { name: "Search menu", exact: true });
      const chips = composer.locator('[data-composer-chip="codexhost-delegation"]');
      for (const existing of [false, true]) {
        if (existing) await open();
        await composer.fill("@");
        await targets.last().waitFor();
        if (existing) await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
        assert.deepEqual(
          (await menu.getByRole("option").allTextContents()).slice(0, 3),
          expectedTargets,
        );
        await composer.fill("/");
        await menu.getByRole("option", { name: /^Model\b/ }).waitFor();
        assert.equal(await targets.count(), 0, "typed slash does not gain delegation targets");

        await composer.fill("Before After");
        await composer.press("Home");
        for (let i = 0; i < 7; i++) await composer.press("ArrowRight");
        await attach();
        await plus.click();
        await targets.last().waitFor();
        await menu.locator('[role="option"][id*="codexhost-thread"]').first().waitFor();
        if (existing) await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
        assert.deepEqual(await targets.allTextContents(), expectedTargets);
        assert.deepEqual(
          (await menu.getByRole("option").allTextContents()).slice(-3),
          expectedTargets,
        );
        assert.equal(await menu.getByRole("option", { name: /Missing|Usage/ }).count(), 0);
        const inspectCount = host.requests.filter(
          (r) => r.method === "codexhost/harness/inspect",
        ).length;

        for (const query of ["alpha-agent", "Alpha"]) {
          await search.fill(query);
          await page.waitForFunction(
            () => document.querySelectorAll('[data-trigger-menu] [role="option"]').length === 1,
          );
          await menu.getByRole("option", { name: "Alpha alpha-agent", exact: true }).waitFor();
          assert.equal(
            await composer.innerText(),
            "Before After",
            "search leaves the draft intact",
          );
        }
        await search.press("Enter");
        await chips.waitFor();
        await menu.waitFor({ state: "hidden" });
        assert.equal((await composer.innerText()).replace(/\s+/gu, " "), "Before Alpha After");
        await page.getByText("kept.txt", { exact: true }).waitFor();
        assert.equal(
          writeMethods().length,
          0,
          "selecting a target does not allocate or submit a Thread",
        );
        assert.equal(
          host.requests.filter((r) => r.method === "codexhost/harness/inspect").length,
          inspectCount,
          "search and selection reuse the existing Harness catalog",
        );
        if (!existing)
          assert.equal(
            host.requests.some((r) => r.method === "codexhost/thread/commands/inspect"),
            false,
          );
        await composer.press("ControlOrMeta+A");
        await composer.press("ControlOrMeta+C");
        assert.equal(
          (await page.evaluate(() => navigator.clipboard.readText())).trim(),
          "Before [@Alpha](subagent://codexhost.alpha-agent) After",
        );
        await composer.press("ControlOrMeta+Z");
        await chips.waitFor({ state: "detached" });
        assert.equal(await composer.innerText(), "Before After");
      }
    },
  );
