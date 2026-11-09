/** Model picker settlement and focus ownership against the real Web composition. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { startServer } from "../support/server.ts";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { createHarnessAdapter as createFake } from "../fake-harness/fake/plugin.ts";
import { createHarnessAdapter as createOther } from "../fake-harness/other/plugin.ts";

const selectionUrl = "**/api/session/selectModel";
const composerLabel = "Describe what you want to build, / commands, @ files or sessions";

async function startPicker(t: TestContext, width: number, fast = false): Promise<Page> {
  const host = new FakeChHost();
  const adapters = { fake: createFake(), other: createOther() };
  if (fast) {
    const inspect = adapters.other.inspect;
    adapters.other.inspect = async () => {
      const inspection = await inspect();
      const [first] = inspection.catalog.models;
      if (first) Object.assign(first, { fastModel: { id: "other-model-priority" } });
      return inspection;
    };
  }
  t.after(async () => {
    await Promise.all(Object.values(adapters).map((adapter) => adapter.close()));
  });
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/harness/plugins/list")
      return {
        plugins: [
          { id: "fake", name: "Fake Harness", version: "1" },
          { id: "other", name: "Other Harness", version: "1" },
        ],
      } as T;
    if (method === "codexhost/harness/inspect")
      return (await adapters[params.harnessId as keyof typeof adapters].inspect()) as T;
    return request<T>(method, params);
  };
  const debuggerServer = await startFakeChDebugger(host);
  t.after(() => debuggerServer.close());
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    ["--ch-cdp", debuggerServer.endpoint],
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
    `model search pointer interaction keeps the menu open at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const page = await startPicker(t, width);
      await openModels(page, "Other Model");
      const search = page.getByRole("searchbox", { name: "Search models…", exact: true });
      await search.click();
      assert.equal(await trigger(page).getAttribute("aria-expanded"), "true");
      // The visible search field includes padding outside the native input.
      await search.locator("..").click({ position: { x: 2, y: 2 } });
      assert.equal(await trigger(page).getAttribute("aria-expanded"), "true");
      assert.equal(await search.evaluate((element) => element === document.activeElement), true);
      const panel = page.getByRole("group", { name: "Model", exact: true });
      await panel.getByText("Model", { exact: true }).click();
      await panel.click({ position: { x: 4, y: 40 } });
      if (width >= 600) {
        await page.getByText("Thinking", { exact: true }).click();
      }
      assert.equal(await trigger(page).getAttribute("aria-expanded"), "true");
      assert.equal(await search.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.type("Other Alternate");
      assert.equal(await search.inputValue(), "Other Alternate");
      await page.getByRole("menuitemradio", { name: "Other Alternate", exact: true }).waitFor();
      await page.mouse.click(2, 2);
      assert.equal(await trigger(page).getAttribute("aria-expanded"), "false");
    },
  );

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

  it(`Fast toggles the current Model's variant at ${width}px`, { timeout: 60_000 }, async (t) => {
    const page = await startPicker(t, width, true);
    type Selection = { provider: string; model: string; reasoningEffort?: string };
    const selections: Selection[] = [];
    await page.route(selectionUrl, async (route) => {
      const body = route.request().postDataJSON() as {
        payload: { args: { request: Selection & { sessionId: string } } };
      };
      const { provider, model, reasoningEffort } = body.payload.args.request;
      selections.push({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
      await route.continue();
    });
    const fast = page.getByRole("button", { name: "Fast", exact: true });
    const current = (effort: string) =>
      page
        .getByRole("button", {
          name: `Select model, current Other Model, reasoning effort ${effort}`,
          exact: true,
        })
        .waitFor();
    assert.equal(await fast.getAttribute("aria-pressed"), "false");

    await fast.hover();
    await page.getByRole("tooltip").getByText("Fast is off · Click to enable").waitFor();
    await fast.click();
    await page.locator('[aria-label="Fast"][aria-pressed="true"]').waitFor();
    // The variant is the same Model: label, Thinking and menu state are unchanged.
    await current("High");
    assert.equal(await trigger(page).getAttribute("aria-expanded"), "false");
    assert.deepEqual(selections.at(-1), {
      provider: "other",
      model: "other-model-priority",
      reasoningEffort: "high",
    });

    // Thinking keeps Fast; the Model menu checks the base Model row.
    await trigger(page).click();
    await page.getByRole("menuitemradio", { name: "Low", exact: true }).click();
    await current("Low");
    assert.equal(selections.at(-1)?.model, "other-model-priority");
    assert.equal(await fast.getAttribute("aria-pressed"), "true");
    await openModels(page, "Other Model");
    assert.equal(
      await page
        .getByRole("menuitemradio", { name: "Other Model", exact: true })
        .getAttribute("aria-checked"),
      "true",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await fast.click();
    await page.locator('[aria-label="Fast"][aria-pressed="false"]').waitFor();
    assert.equal(selections.at(-1)?.model, "other-model");
    assert.equal(selections.at(-1)?.reasoningEffort, "low");

    // Models without a Fast variant hide the control.
    await openModels(page, "Other Model");
    await page.getByRole("menuitemradio", { name: "Other Alternate", exact: true }).click();
    await fast.waitFor({ state: "detached" });
  });
}
