import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Route } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { PNG } from "../support/image.ts";
import { defined } from "../support/defined.ts";

it(
  "mobile stalled uploads time out, release the queue and retain foreground/manual retries",
  { timeout: 100_000 },
  async (t) => {
    const host = new FakeChHost();
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
        "--adapters",
        "test/fake-harness",
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    const held: Route[] = [];
    await context.route("**/api/session/uploadFileBinary?*", (route) => {
      held.push(route);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor();
    await page.locator("[data-composer-input]:visible").pressSequentially("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /^File\b/u }).click();
    const started = performance.now();
    await (
      await chooser
    ).setFiles(
      ["first.png", "second.png", "third.png"].map((name) => ({
        name,
        mimeType: "image/png",
        buffer: Buffer.from(PNG, "base64"),
      })),
    );
    const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
    const retry = (name: string) =>
      pending.getByRole("button", { name: `Retry uploading ${name}`, exact: true });
    await retry("first.png").waitFor({ timeout: 75_000 });
    await retry("second.png").waitFor();
    t.diagnostic(
      `stalled Worker uploads became retryable after ${(performance.now() - started).toFixed(0)} ms`,
    );
    assert.equal(held.length, 3, "timeout frees both active slots for the queued image");
    assert.equal(new URL(defined(held[2]).request().url()).searchParams.get("name"), "third.png");
    await defined(held[2]).continue();
    const foreground = () =>
      page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await foreground();
    for (let i = 0; held.length < 5 && i < 200; i++) await page.waitForTimeout(10);
    assert.equal(held.length, 5, "returning to foreground automatically retries the failed pair");
    await defined(held[3]).abort("failed");
    await defined(held[4]).abort("failed");
    await retry("first.png").waitFor();
    await retry("second.png").waitFor();
    await foreground();
    await page.waitForTimeout(100);
    assert.equal(held.length, 5, "foreground retries happen only once per attachment");
    for (const [index, name] of ["first.png", "second.png"].entries()) {
      await retry(name).click();
      for (let i = 0; held.length < index + 6 && i < 200; i++) await page.waitForTimeout(10);
      assert.equal(held.length, index + 6);
      await defined(held[index + 5]).continue();
    }
    await pending.getByText(/Uploading/u).waitFor({ state: "detached" });
    assert.equal(await pending.getByRole("button", { name: /^Retry uploading/u }).count(), 0);
    assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 0);
    assert.deepEqual(errors, []);
  },
);
