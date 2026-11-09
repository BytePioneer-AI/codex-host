/** `--dev-web-ui`: a rebuilt plugin is swapped into the open page; a rebuilt shell reloads it. */
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "@playwright/test";
import { startServer } from "../support/server.ts";

const WEB_UI = resolve(import.meta.dirname, "../../../../apps/web-ui");

it("swaps a rebuilt plugin without reloading and reloads for a rebuilt shell", async (t) => {
  // A built copy, so the test rewrites bundles without touching the checkout's artifacts.
  const copy = mkdtempSync(join(tmpdir(), "codexhost-dev-web-ui-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(WEB_UI, copy, {
    recursive: true,
    filter: (source) => !["node_modules", "src", "tests", ".git"].includes(basename(source)),
  });
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    ["--dev-web-ui", copy],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const channel = page.waitForResponse((response) => response.url().includes("plugins/events"));
  await page.goto(url);
  assert.equal((await channel).headers()["content-type"], "text/event-stream");
  await page.evaluate(() => {
    (globalThis as { __pageMark?: number }).__pageMark = 1;
  });

  appendFileSync(
    join(copy, "packages/client/ui-codexhost/lib/client.js"),
    '\nglobalThis.__hmrProbe = "swapped";\n',
  );
  await page.waitForFunction(
    () => (globalThis as { __hmrProbe?: string }).__hmrProbe === "swapped",
  );
  assert.equal(await page.evaluate(() => (globalThis as { __pageMark?: number }).__pageMark), 1);

  const shell = join(copy, "apps/web/dist/index.html");
  const reloaded = page.waitForEvent("load");
  writeFileSync(shell, readFileSync(shell, "utf8").replace("</body>", "<!-- rebuilt --></body>"));
  await reloaded;
  assert.equal(
    await page.evaluate(() => (globalThis as { __pageMark?: number }).__pageMark),
    undefined,
  );
  assert.deepEqual(errors, []);
});
