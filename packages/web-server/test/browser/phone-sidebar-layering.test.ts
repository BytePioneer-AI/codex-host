import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Locator, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function columnStyles(page: Page) {
  return page
    .locator('[data-phone] > [class*="_centerCol"], [data-phone] > [data-rightbar-col]')
    .evaluateAll((columns) =>
      columns.map((column) => ({
        isolation: getComputedStyle(column).isolation,
        zIndex: getComputedStyle(column).zIndex,
      })),
    );
}

async function shot(page: Page, name: string) {
  const directory = process.env.CODEXHOST_TEST_SCREENSHOTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getTiming().iterations === Infinity ||
          animation.playState !== "running",
      ),
  );
  await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(await columnStyles(page), null, 2));
}

async function exposed(control: Locator) {
  assert.equal(
    await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      );
    }),
    true,
    "the visible control must also win hit testing",
  );
}

it(
  "phone closed-drawer model/Composer popups and right panel retain their stacking",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    host.add("layer-thread", "/computer/layering", "Layering thread");
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--dev-web-ui",
        resolve("apps/web-ui"),
      ],
      { authenticated: true },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        colorScheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const target = new URL(url);
      target.searchParams.set("session", "layer-thread");
      await page.goto(target.href);
      await page.getByText("existing CH answer", { exact: true }).waitFor();
      await page.waitForLoadState("networkidle");
      const originalColumns = [
        { isolation: "auto", zIndex: "auto" },
        { isolation: "auto", zIndex: "auto" },
      ];
      assert.deepEqual(
        await columnStyles(page),
        originalColumns,
        "a closed drawer leaves both columns' original stacking styles intact",
      );
      await shot(page, `${colorScheme}-closed`);
      const model = page.getByRole("button", { name: /^Select model, current Native Model/ });
      await model.click();
      const native = page
        .getByRole("menu", { name: "Thinking", exact: true })
        .getByRole("menuitem", { name: "Native Model", exact: true });
      await native.waitFor();
      await exposed(native);
      await shot(page, `${colorScheme}-model`);
      await native.click();
      const modelMenu = page.getByRole("menu", { name: "Model", exact: true });
      await modelMenu.waitFor();
      await exposed(modelMenu.getByRole("menuitemradio", { name: "Native Model", exact: true }));
      await shot(page, `${colorScheme}-model-options`);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const plus = page.getByRole("button", { name: "Add files or run commands", exact: true });
      await plus.click();
      const commands = page.getByRole("listbox", { name: "Trigger suggestions", exact: true });
      await commands.waitFor();
      await exposed(commands.getByRole("option", { name: /^Model\b/ }));
      await shot(page, `${colorScheme}-composer`);
      await page.locator("[data-composer-input]:visible").press("Escape");
      await commands.waitFor({ state: "hidden" });
      await page.locator("[data-sidebar-right-expand]").click();
      const right = page.locator("[data-sidebar-right-open]");
      await right.waitFor();
      const collapseRight = page.locator("[data-sidebar-right-toggle]");
      await exposed(collapseRight);
      await page.locator('[data-sidebar-right-guide-entry="files"]').waitFor();
      assert.equal(
        await right.evaluate((panel) => {
          const leading = document.querySelector("[data-shell-leading] button");
          if (leading === null) throw new Error("Main leading control missing");
          const box = leading.getBoundingClientRect();
          return panel.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
        true,
        "the fullscreen right panel covers the main leading controls, rather than showing them through its header",
      );
      await shot(page, `${colorScheme}-right-panel`);
      await collapseRight.click();
      await right.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
      const drawer = page.locator("[data-phone-drawer]");
      await page.waitForFunction(() => {
        const drawer = document.querySelector("[data-phone-drawer]");
        return drawer !== null && new DOMMatrix(getComputedStyle(drawer).transform).m41 === 0;
      });
      assert.equal(
        await drawer.evaluate((element) => getComputedStyle(element).backdropFilter),
        "blur(18px)",
      );
      await exposed(drawer.getByRole("button", { name: "Collapse sidebar", exact: true }));
      await shot(page, `${colorScheme}-drawer`);
      await page.mouse.click(375, 350);
      await page.waitForFunction(() => {
        const drawer = document.querySelector("[data-phone-drawer]");
        return drawer !== null && getComputedStyle(drawer).visibility === "hidden";
      });
      assert.deepEqual(
        await columnStyles(page),
        originalColumns,
        "closing restores the original styles after drawer use",
      );
      await shot(page, `${colorScheme}-closed-again`);
      await model.click();
      await native.waitFor();
      await exposed(native);
      await page.keyboard.press("Escape");
      assert.deepEqual(errors, []);
      await context.close();
    }
    assert.equal(
      host.requests.some((request) => ["turn/start", "thread/start"].includes(request.method)),
      false,
    );
  },
);

it(
  "phone material has no solid bottom fade over white, text, code or blue message backgrounds",
  { timeout: 90_000 },
  async (t) => {
    const host = new FakeChHost();
    for (let i = 0; i < 24; i++)
      host.add(`padding-${i}`, "/computer/materials", `Long list item ${i}`);
    const surfaces = ["white", "text", "code", "blue"] as const;
    for (const surface of surfaces) {
      const thread = host.add(`surface-${surface}`, "/computer/materials", `Backdrop ${surface}`);
      const userText =
        `Backdrop probe: ${surface}` +
        (surface === "blue"
          ? "\n\n" +
            Array.from(
              { length: 35 },
              (_, i) =>
                `Blue message background paragraph ${i}. This is fixture conversation content.`,
            ).join("\n\n")
          : "");
      const answer =
        surface === "code"
          ? [
              "```ts",
              ...Array.from({ length: 35 }, (_, i) => `const material_code_${i} = ${i};`),
              "```",
            ].join("\n")
          : surface === "text"
            ? Array.from(
                { length: 35 },
                (_, i) => `Text background paragraph ${i}. This is fixture conversation content.`,
              ).join("\n\n")
            : surface === "white"
              ? "Ready."
              : "";
      thread.turns = [
        {
          id: `history-${surface}`,
          status: "completed",
          items: [
            {
              id: `user-${surface}`,
              type: "userMessage",
              content: [{ type: "text", text: userText }],
            },
            ...(answer
              ? [{ id: `answer-${surface}`, type: "agentMessage" as const, text: answer }]
              : []),
          ],
        },
      ];
    }
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--dev-web-ui",
        resolve("apps/web-ui"),
      ],
      { authenticated: true },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    for (const colorScheme of ["light", "dark"] as const)
      for (const surface of surfaces) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          colorScheme,
          hasTouch: true,
          isMobile: true,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        const target = new URL(url);
        target.searchParams.set("session", `surface-${surface}`);
        await page.goto(target.href);
        await page
          .getByText(new RegExp(`Backdrop probe: ${surface}`))
          .first()
          .waitFor({ state: "attached" });
        await page.waitForLoadState("networkidle");
        await shot(page, `${colorScheme}-${surface}-background`);
        await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
        const drawer = page.locator("[data-phone-drawer]");
        await drawer.getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
        const fades = await drawer.locator('span[class*="_fade"]').evaluateAll((elements) =>
          elements.map((element) => ({
            display: getComputedStyle(element).display,
            paintedRects: element.getClientRects().length,
          })),
        );
        assert.ok(fades.length > 0);
        assert.ok(
          fades.every((fade) => fade.display === "none" && fade.paintedRects === 0),
          "no opaque gradient is painted at the list's lower edge",
        );
        const list = drawer.locator('[role="tree"]').first();
        assert.deepEqual(
          await list.evaluate((element) => ({
            scrollbar: getComputedStyle(element).scrollbarWidth,
            gutter: getComputedStyle(element).scrollbarGutter,
            paddingRight: getComputedStyle(element).paddingRight,
            reservedScrollbar: (element as HTMLElement).offsetWidth - element.clientWidth,
          })),
          { scrollbar: "none", gutter: "auto", paddingRight: "10px", reservedScrollbar: 0 },
        );
        await shot(page, `${colorScheme}-${surface}-drawer-no-fade`);
        await context.close();
      }
  },
);
