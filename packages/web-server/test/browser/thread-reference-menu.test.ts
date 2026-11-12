import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

async function setup(t: TestContext, width: number) {
  const host = new FakeChHost();
  host.add("destination", "/computer/project", "Destination");
  host.add("source", "/computer/project", "Source [one]");
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
      ...(process.env.CODEXHOST_TEST_WEB_UI_DIRECTORY
        ? ["--dev-web-ui", process.env.CODEXHOST_TEST_WEB_UI_DIRECTORY]
        : []),
    ],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: 844 },
    locale: "en-US",
    hasTouch: width < 640,
    isMobile: width < 640,
    reducedMotion: "reduce",
  });
  const destination = new URL(url);
  destination.searchParams.set("session", "destination");
  await page.goto(destination.href);
  const composer = page.locator('[data-conversation-session="destination"] [data-composer-input]');
  await composer.waitFor();
  const openMenu = async (id: string) => {
    if (width < 640)
      await page.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
    const folder = page.locator('[data-row-key^="workspace:"]').filter({ hasText: /^project$/ });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    const row = page.locator(`[data-row-key="session:${id}"]`);
    if (width >= 640) await row.hover();
    await row.getByRole("button", { name: /^Session actions/ }).click();
    await page.getByRole("menu").waitFor();
  };
  return { host, page, composer, openMenu };
}

for (const width of [390, 1280]) {
  it(
    `session menu references the source without sending or navigating at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { host, page, composer, openMenu } = await setup(t, width);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await composer.fill("Keep this draft ");
      await composer.press("End");
      await openMenu("source");
      const action = page.getByRole("menuitem", { name: "Reference session", exact: true });
      await action.waitFor();
      assert.equal(await action.isEnabled(), true);
      const before = host.requests.length;
      const url = page.url();
      await action.click();
      await page.getByRole("menu").waitFor({ state: "detached" });
      await page.locator("[data-phone-drawer][data-open]").waitFor({ state: "detached" });
      const chip = composer.locator('[data-composer-chip="codexhost-thread"]');
      await chip.waitFor();
      assert.equal(await chip.innerText(), "Source [one]");
      assert.ok((await composer.innerText()).startsWith("Keep this draft "));
      assert.equal(page.url(), url);
      await page.getByText("Added to the current draft", { exact: true }).waitFor();
      assert.equal(
        host.requests
          .slice(before)
          .some(
            (request) =>
              ["thread/start", "turn/start", "thread/fork"].includes(request.method) ||
              (request.method === "thread/turns/list" && request.params.threadId === "source"),
          ),
        false,
        "insertion neither reads source history nor creates work",
      );
      const response = page.waitForResponse((reply) => reply.url().endsWith("/api/session/prompt"));
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      assert.equal((await response).status(), 200);
      const turn = host.requests.find((request) => request.method === "turn/start");
      assert.ok(turn);
      assert.equal(turn.params.threadId, "destination");
      assert.equal(
        (turn.params.input as Array<{ text: string }>)
          .map((part) => part.text)
          .join("\n")
          .trim(),
        "Keep this draft [@Source \\[one\\]](thread://source?hostId=local)",
      );
      assert.deepEqual(errors, []);
    },
  );

  it(`session menu does not offer self-reference at ${width}px`, { timeout: 60_000 }, async (t) => {
    const { page, openMenu } = await setup(t, width);
    await openMenu("destination");
    await page.getByRole("menuitem", { name: "Copy session link", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("menuitem", { name: "Reference session", exact: true }).count(),
      0,
    );
  });
}
