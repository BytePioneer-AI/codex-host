import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountRendererHarnessSkillControl } from "./packages/renderer-extension/src/renderer-harness-skill-control.ts";

      const NONE_SKILL = {
        id: "claude.skill.review",
        invocation: "/review",
        label: "Review",
        description: "Review the current diff",
        argumentMode: "none",
      };
      const TEXT_SKILL = {
        id: "claude.skill.commit",
        invocation: "/commit",
        label: "Commit",
        description: "Create a git commit",
        argumentMode: "text",
      };

      globalThis.setupRendererHarnessSkillControl = (initialLocale) => {
        const selections = [];
        globalThis.__skillSelections = selections;
        const toolbar = document.createElement("div");
        document.body.append(toolbar);
        const control = mountRendererHarnessSkillControl(
          toolbar,
          null,
          (skill, argument) => {
            selections.push({ id: skill.id, argument });
          },
          initialLocale,
        );
        globalThis.__skillSetSkills = (skills) => control.setSkills(skills);
        globalThis.__skillSetExecuting = (commandId) => control.setExecuting(commandId);
        globalThis.__skillOpen = () => control.open();
        globalThis.__skillHasSkills = () => control.hasSkills();
        globalThis.__skillClearSelections = () => {
          selections.length = 0;
        };
        control.setSkills([NONE_SKILL, TEXT_SKILL]);
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-harness-skill-control-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Harness skill control bundle was not generated");

const mountSkillControl = async (page: Page, locale = "en"): Promise<void> => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate((setLocale: string) => {
    const setup = Reflect.get(globalThis, "setupRendererHarnessSkillControl");
    if (typeof setup !== "function") throw new Error("Skill control setup is unavailable");
    (setup as (locale: string) => void)(setLocale);
  }, locale);
};

async function callBrowser(page: Page, name: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ([target, callArgs]) => {
      const fn = Reflect.get(globalThis, target);
      if (typeof fn !== "function") throw new Error(`${target} is unavailable`);
      return (fn as (...values: unknown[]) => unknown)(...callArgs);
    },
    [name, args] as [string, unknown[]],
  );
}

function selections(page: Page): Promise<Array<{ id: string; argument: string | undefined }>> {
  return page.evaluate(
    () =>
      Reflect.get(globalThis, "__skillSelections") as Array<{
        id: string;
        argument: string | undefined;
      }>,
  );
}

const trigger = (page: Page) => page.locator("[data-codexhost-harness-skill-control] button");
const menu = (page: Page) => page.locator("[data-codexhost-harness-skill-menu]");
const items = (page: Page) => page.locator('[data-codexhost-harness-skill-menu] [role="menuitem"]');

test("hides the control for an empty catalog and reveals it when skills arrive", async ({
  page,
}) => {
  await mountSkillControl(page);
  await callBrowser(page, "__skillSetSkills", []);
  // The empty gate is real visibility: the root carries both the `hidden`
  // attribute and a `display: none` inline style, since the mount-time
  // `display: inline-flex` would otherwise defeat the UA [hidden] rule.
  await expect(page.locator("[data-codexhost-harness-skill-control]")).toBeHidden();
  expect(await callBrowser(page, "__skillHasSkills")).toBe(false);
  // open() is a no-op while the catalog is empty: the popover stays hidden.
  await callBrowser(page, "__skillOpen");
  await expect(menu(page)).toBeHidden();

  await callBrowser(page, "__skillSetSkills", [
    {
      id: "claude.skill.review",
      invocation: "/review",
      label: "Review",
      description: "Review the current diff",
      argumentMode: "none",
    },
  ]);
  await expect(page.locator("[data-codexhost-harness-skill-control]")).toBeVisible();
  expect(await callBrowser(page, "__skillHasSkills")).toBe(true);
});

test("opens with invocations and descriptions and toggles aria-expanded", async ({ page }) => {
  await mountSkillControl(page);
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(menu(page)).toBeVisible();
  await expect(items(page)).toHaveCount(2);
  await expect(menu(page)).toContainText("/review");
  await expect(menu(page)).toContainText("Review the current diff");
  await expect(menu(page)).toContainText("/commit");
  await expect(menu(page)).toContainText("Create a git commit");
});

test("narrows the items with the filter input by name or description", async ({ page }) => {
  await mountSkillControl(page);
  await trigger(page).click();
  const filter = page.locator('[role="searchbox"]');
  await expect(filter).toBeVisible();
  await expect(filter).toHaveAttribute("aria-label", "Filter skills");
  await filter.fill("git");
  await expect(items(page)).toHaveCount(1);
  await expect(menu(page)).toContainText("/commit");
  await filter.fill("COMMIT the current");
  await expect(items(page)).toHaveCount(0);
  await filter.fill("");
  await expect(items(page)).toHaveCount(2);
});

test("selects an argument-less skill on click and closes the popover", async ({ page }) => {
  await mountSkillControl(page);
  await trigger(page).click();
  await items(page).first().click();
  await expect(menu(page)).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  expect(await selections(page)).toEqual([{ id: "claude.skill.review", argument: undefined }]);
});

test("enters the argument phase for a text skill and submits the trimmed value on Enter", async ({
  page,
}) => {
  await mountSkillControl(page);
  await trigger(page).click();
  await items(page).nth(1).click();
  const argument = page.locator("[data-codexhost-harness-skill-argument]");
  await expect(argument).toBeVisible();
  await expect(argument).toBeFocused();
  await expect(menu(page)).toContainText("/commit");
  await argument.fill("  fix login flake  ");
  await argument.press("Enter");
  await expect(menu(page)).toBeHidden();
  expect(await selections(page)).toEqual([
    { id: "claude.skill.commit", argument: "fix login flake" },
  ]);

  // A blank argument submits as undefined, the same as the none-mode path.
  await callBrowser(page, "__skillClearSelections");
  await trigger(page).click();
  await items(page).nth(1).click();
  await argument.fill("   ");
  await argument.press("Enter");
  await expect(menu(page)).toBeHidden();
  expect(await selections(page)).toEqual([{ id: "claude.skill.commit", argument: undefined }]);
});

test("Escape in the argument phase returns to the list without selecting", async ({ page }) => {
  await mountSkillControl(page);
  await trigger(page).click();
  await items(page).nth(1).click();
  const argument = page.locator("[data-codexhost-harness-skill-argument]");
  await argument.fill("draft");
  await argument.press("Escape");
  await expect(menu(page)).toBeVisible();
  await expect(items(page)).toHaveCount(2);
  await expect(argument).toBeHidden();
  expect(await selections(page)).toEqual([]);
});

test("keeps the argument input across a catalog refresh and shows the new list after Escape", async ({
  page,
}) => {
  await mountSkillControl(page);
  await trigger(page).click();
  await items(page).nth(1).click();
  const argument = page.locator("[data-codexhost-harness-skill-argument]");
  await expect(argument).toBeVisible();
  await argument.fill("  keep me  ");
  await callBrowser(page, "__skillSetSkills", [
    {
      id: "claude.skill.deploy",
      invocation: "/deploy",
      label: "Deploy",
      description: "Deploy the app",
      argumentMode: "none",
    },
  ]);
  await expect(argument).toBeVisible();
  await expect(argument).toHaveValue("  keep me  ");
  expect(await selections(page)).toEqual([]);

  await argument.press("Escape");
  await expect(menu(page)).toBeVisible();
  await expect(items(page)).toHaveCount(1);
  await expect(menu(page)).toContainText("/deploy");
  await expect(menu(page)).not.toContainText("/commit");
});

test("Escape closes from the list and outside pointerdown dismisses the popover", async ({
  page,
}) => {
  await mountSkillControl(page);
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
  // First Escape leaves the filter input; the second closes the popover.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();

  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
  await page.mouse.click(600, 600);
  await expect(menu(page)).toBeHidden();
});

test("ignores item clicks while a skill is executing", async ({ page }) => {
  await mountSkillControl(page);
  await callBrowser(page, "__skillSetExecuting", "claude.skill.commit");
  await callBrowser(page, "__skillOpen");
  await expect(menu(page)).toBeHidden();

  await callBrowser(page, "__skillSetExecuting", null);
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
  await callBrowser(page, "__skillSetExecuting", "claude.skill.commit");
  await expect(items(page).first()).toBeDisabled();
  await items(page).first().click({ force: true });
  expect(await selections(page)).toEqual([]);
});

test("localizes the Skills chrome in Chinese", async ({ page }) => {
  await mountSkillControl(page, "zh-CN");
  await expect(trigger(page)).toHaveAttribute("aria-label", "技能");
  await trigger(page).click();
  await expect(page.locator('[role="searchbox"]')).toHaveAttribute("aria-label", "过滤技能");
  await items(page).nth(1).click();
  await expect(menu(page)).toContainText("返回");
});
