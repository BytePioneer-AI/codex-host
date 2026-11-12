import assert from "node:assert/strict";
import { it } from "node:test";
import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";
import { discoveryBrowser } from "../support/discovery-browser.ts";

for (const width of [390, 1280])
  it(
    `deduplicates command and Skill titles without changing invocations at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { state, page, composer, menu, open } = await discoveryBrowser(t, width);
      state.catalog = harnessCommandCatalogSchema.parse({
        ...state.catalog,
        commands: [
          ...state.catalog.commands,
          {
            id: "fake.named-skill",
            invocation: "/skill:codexhost-add-harness",
            label: "skill:codexhost-add-harness",
            description: "Add a Harness plugin",
            argumentMode: "text",
            kind: "skill",
          },
          {
            id: "fake.clean-skill",
            invocation: "/skill:clean",
            label: "clean",
            argumentMode: "text",
            kind: "skill",
          },
          {
            id: "fake.llama",
            invocation: "/llama",
            label: "llama",
            argumentMode: "text",
          },
          {
            id: "fake.same-skill",
            invocation: "/same-skill",
            label: "/Same-Skill",
            argumentMode: "text",
            kind: "skill",
          },
        ],
      });
      await open();
      for (const trigger of ["/", "#"]) {
        await composer.fill(trigger);
        const skill = menu.getByRole("option", {
          name: "codexhost-add-harness Add a Harness plugin",
          exact: true,
        });
        await skill.waitFor();
        assert.equal(await skill.locator("span").count(), 2, "one title and one description");
        assert.equal(await menu.getByRole("option", { name: "llama", exact: true }).count(), 1);
        assert.equal(await menu.getByRole("option", { name: "clean", exact: true }).count(), 1);
        assert.equal(
          await menu.getByRole("option", { name: "/Same-Skill", exact: true }).count(),
          1,
        );
        assert.equal(
          await menu.getByRole("option", { name: "Native skill", exact: true }).count(),
          1,
          "Skills show only their display title",
        );
        assert.equal(
          await menu.getByRole("option", { name: "Native info /native-info", exact: true }).count(),
          1,
          "a genuinely different command title keeps its invocation alias",
        );
        assert.equal(
          await skill.evaluate((row) => {
            const [title, description] = row.querySelectorAll("span");
            if (!title || !description) return false;
            const a = title.getBoundingClientRect();
            const b = description.getBoundingClientRect();
            return Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 1;
          }),
          true,
          "the title and description stay on one line",
        );
        for (const query of ["codexhost-add-harness", "skill:codexhost-add-harness"]) {
          await composer.fill(`${trigger}${query}`);
          await skill.waitFor();
        }
        await skill.click();
        const chip = composer.locator('[data-composer-chip="codexhost-native"]');
        await chip.waitFor();
        assert.equal(
          await chip.getByText("/skill:codexhost-add-harness", { exact: true }).count(),
          1,
        );
        await page.keyboard.press("Escape");
      }
    },
  );
