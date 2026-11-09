import assert from "node:assert/strict";
import { it } from "node:test";
import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";
import { discoveryBrowser } from "../support/discovery-browser.ts";

for (const width of [390, 1280])
  it(
    `keeps the current discovery category above scrolling rows at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { state, page, composer, menu, open, writeMethods } = await discoveryBrowser(
        t,
        width,
        true,
      );
      state.catalog = harnessCommandCatalogSchema.parse({
        source: "live",
        commands: [
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `fake.command-${index}`,
            invocation: `/command-${index}`,
            label: `Command ${index}`,
            argumentMode: "text",
          })),
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `fake.skill-${index}`,
            invocation: `/skill:sticky-${index}`,
            label: `skill:sticky-${index}`,
            argumentMode: "text",
            kind: "skill",
          })),
        ],
      });
      await open();
      await composer.fill("#");
      await menu.getByRole("option", { name: "sticky-19", exact: true }).waitFor();

      for (const label of ["Delegation Agents", "Native commands", "Skills"]) {
        const heading = menu.getByText(label, { exact: true });
        assert.equal(
          await heading.evaluate((element) => getComputedStyle(element).position),
          "sticky",
        );
        await heading.evaluate((element) => {
          const viewport = element.closest<HTMLElement>('[role="listbox"]');
          if (!viewport) throw new Error("Missing menu viewport");
          viewport.scrollTop = 0;
          viewport.scrollTop =
            element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 45;
        });
        await page.waitForFunction((label) => {
          const viewport = document.querySelector<HTMLElement>(
            '[data-trigger-menu] [role="listbox"]',
          );
          if (!viewport) return false;
          const bounds = viewport.getBoundingClientRect();
          const heading = document
            .elementFromPoint(bounds.left + 20, bounds.top + 10)
            ?.closest("[data-menu-group-heading]");
          return heading?.textContent === label && heading.hasAttribute("data-stuck");
        }, label);
        assert.ok(
          await heading.evaluate((element) => {
            const viewport = element.closest<HTMLElement>('[role="listbox"]');
            if (!viewport) return false;
            return (
              Math.abs(element.getBoundingClientRect().top - viewport.getBoundingClientRect().top) <
              1
            );
          }),
          `${label} stays at the viewport top`,
        );
      }

      const commands = menu.getByText("Native commands", { exact: true });
      await commands.evaluate((element) => {
        const viewport = element.closest<HTMLElement>('[role="listbox"]');
        if (!viewport) throw new Error("Missing menu viewport");
        viewport.scrollTop = 0;
        viewport.scrollTop =
          element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 10;
      });
      const agentsBox = await menu.getByText("Delegation Agents", { exact: true }).boundingBox();
      const commandsBox = await commands.boundingBox();
      assert.ok(
        agentsBox && commandsBox && agentsBox.y + agentsBox.height <= commandsBox.y + 1,
        "the next category pushes the previous heading away",
      );

      await composer.fill("#skill:sticky-");
      await menu.getByRole("option", { name: "sticky-19", exact: true }).waitFor();
      for (let i = 0; i < 15; i++) await composer.press("ArrowDown");
      const active = menu.locator('[role="option"][aria-selected="true"]');
      const invocation = `/skill:${await active.innerText()}`;
      const activeBox = await active.boundingBox();
      const skillsBox = await menu.getByText("Skills", { exact: true }).boundingBox();
      assert.ok(
        activeBox && skillsBox && activeBox.y >= skillsBox.y + skillsBox.height - 1,
        "keyboard selection is not hidden behind the sticky heading",
      );
      assert.equal(writeMethods().length, 0);
      await composer.press("Enter");
      await composer
        .locator('[data-composer-chip="codexhost-native"]')
        .getByText(invocation, { exact: true })
        .waitFor();
    },
  );
