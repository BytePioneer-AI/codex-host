/** Model picker settlement and focus ownership against the real Web composition. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { startServer } from "../support/server.ts";

const selectionUrl = "**/api/session/selectModel";
const composerLabel = "Describe what you want to build, / commands, @ files or sessions";

async function startPicker(t: TestContext, width: number): Promise<Page> {
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    ["--adapters", "test/fake-harness"],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    isMobile: width < 600,
    hasTouch: width < 600,
  });
  await page.goto(url);
  await page
    .getByRole("button", { name: "Select Harness, current Fake Harness", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Other Harness", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Select model, current Other Model, reasoning effort High",
      exact: true,
    })
    .waitFor();
  return page;
}

function trigger(page: Page) {
  return page.getByRole("button", { name: /^Select model, current /u });
}

async function openModels(page: Page, current: string): Promise<void> {
  await trigger(page).click();
  await page
    .getByRole("menu", { name: "Thinking", exact: true })
    .getByRole("menuitem", { name: current, exact: true })
    .click();
  await page.getByRole("menu", { name: "Model", exact: true }).waitFor();
}

async function assertClosedWithFocus(page: Page): Promise<void> {
  await page.getByRole("menu", { name: "Model", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("menu", { name: "Thinking", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await trigger(page).getAttribute("aria-expanded"), "false");
  assert.equal(await trigger(page).evaluate((element) => element === document.activeElement), true);
  assert.equal(await trigger(page).getAttribute("data-selection-focus"), "");
  assert.equal(
    await trigger(page).evaluate((element) => getComputedStyle(element).boxShadow),
    "none",
  );
}

for (const width of [390, 1280]) {
  it(
    `model selection success, current value and rejection at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const page = await startPicker(t, width);
      let selectionRequests = 0;
      let rejectNext = false;
      await page.route(selectionUrl, async (route) => {
        selectionRequests++;
        if (!rejectNext) {
          await route.continue();
          return;
        }
        rejectNext = false;
        const { rpcId } = route.request().postDataJSON() as { rpcId: string };
        await route.fulfill({
          json: {
            type: "server-response",
            rpcId,
            result: {
              ok: false,
              error: {
                code: "session/model-unavailable",
                message: "Selection rejected for test",
                details: {},
              },
            },
          },
        });
      });

      // Current Model closes without a write (or a reset of the current effort).
      await openModels(page, "Other Model");
      await page.getByRole("menuitemradio", { name: "Other Model", exact: true }).click();
      await assertClosedWithFocus(page);
      assert.equal(selectionRequests, 0);

      // A rejected selection leaves the menu usable and the old value selected.
      rejectNext = true;
      await openModels(page, "Other Model");
      await page.getByRole("menuitemradio", { name: "Other Alternate", exact: true }).click();
      await page
        .getByText(
          "Model operation failed: session/model-unavailable: Selection rejected for test",
          { exact: true },
        )
        .waitFor();
      const models = page.getByRole("menu", { name: "Model", exact: true });
      assert.equal(await models.isVisible(), true);
      assert.equal(await trigger(page).getAttribute("aria-expanded"), "true");
      assert.equal(
        await models
          .getByRole("menuitemradio", { name: "Other Model", exact: true })
          .getAttribute("aria-checked"),
        "true",
      );
      assert.equal(
        await models
          .getByRole("menuitemradio", { name: "Other Alternate", exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(selectionRequests, 1);

      // Search + Enter retries through the same selection handler and closes on success.
      const search = page.getByRole("searchbox", { name: "Search models…", exact: true });
      await search.fill("Other Alternate");
      await search.press("Enter");
      await assertClosedWithFocus(page);
      assert.equal(
        await trigger(page).getAttribute("aria-label"),
        "Select model, current Other Alternate, reasoning effort High",
      );
      assert.equal(selectionRequests, 2);

      // Reopen to choose Thinking, then Tab-accept the current Model without resetting Low.
      await trigger(page).click();
      await page.getByRole("menuitemradio", { name: "Low", exact: true }).click();
      await assertClosedWithFocus(page);
      assert.equal(selectionRequests, 3);
      await openModels(page, "Other Alternate");
      await search.fill("Other Alternate");
      await search.press("Tab");
      await assertClosedWithFocus(page);
      assert.equal(
        await trigger(page).getAttribute("aria-label"),
        "Select model, current Other Alternate, reasoning effort Low",
      );
      assert.equal(selectionRequests, 3);
    },
  );

  for (const destination of ["composer", "reopened menu"] as const) {
    it(
      `late model selection preserves ${destination} at ${width}px`,
      { timeout: 60_000 },
      async (t) => {
        const page = await startPicker(t, width);
        const responseGate = Promise.withResolvers<undefined>();
        t.after(() => responseGate.resolve(undefined));
        await page.route(selectionUrl, async (route) => {
          // The durable projection may arrive before the RPC reply; hold only that reply.
          const response = await route.fetch();
          await responseGate.promise;
          await route.fulfill({ response });
        });
        await openModels(page, "Other Model");
        await page.getByRole("menuitemradio", { name: "Other Alternate", exact: true }).click();
        await page
          .getByRole("button", {
            name: "Select model, current Other Alternate, reasoning effort High",
            exact: true,
          })
          .waitFor();
        assert.equal(await trigger(page).getAttribute("aria-busy"), "true");
        assert.equal(await trigger(page).getAttribute("aria-expanded"), "true");

        const composer = page.getByRole("textbox", { name: composerLabel, exact: true });
        await composer.fill("keep typing");
        await page.getByRole("menu", { name: "Model", exact: true }).waitFor({ state: "hidden" });
        if (destination === "reopened menu") await openModels(page, "Other Alternate");

        responseGate.resolve(undefined);
        await trigger(page).and(page.locator('[aria-busy="false"]')).waitFor();
        if (destination === "composer") {
          assert.equal(
            await composer.evaluate((element) => element === document.activeElement),
            true,
          );
          assert.equal(await trigger(page).getAttribute("aria-expanded"), "false");
          await page.keyboard.type(" after reply");
          assert.equal(await composer.innerText(), "keep typing after reply");
        } else {
          assert.equal(
            await page.getByRole("menu", { name: "Model", exact: true }).isVisible(),
            true,
          );
          assert.equal(await trigger(page).getAttribute("aria-expanded"), "true");
          assert.equal(
            await page
              .getByRole("searchbox", { name: "Search models…", exact: true })
              .evaluate((element) => element === document.activeElement),
            true,
          );
        }
      },
    );
  }
}
