import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { PNG } from "../support/image.ts";

it(
  "opens file locations, bounds CJK URLs and reloads overwritten Markdown images on remount",
  { timeout: 60_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "markdown-links-refresh-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const imagePath = join(workspace, "render.png");
    writeFileSync(imagePath, Buffer.from(PNG, "base64"));
    writeFileSync(
      join(workspace, "notes.txt"),
      Array.from({ length: 100 }, (_, index) => `plain line ${index + 1}`).join("\n"),
    );
    const host = new FakeChHost();
    const first = host.add("first", workspace, "First image reply");
    const second = host.add("second", workspace, "Second image reply");
    const firstAnswer = first.turns[0]?.items.at(-1);
    const secondAnswer = second.turns[0]?.items.at(-1);
    assert.ok(firstAnswer);
    assert.ok(secondAnswer);
    firstAnswer.text = [
      "First reply",
      "![First image](./render.png)",
      "[Image preview](./render.png)",
      "[Line range](./notes.txt:24-30) [Line column](./notes.txt:50:3)",
      "预览在 https://example.com/a，然后查看 https://example.org/b😀后文",
      "[Explicit URL](https://example.net/。😀)",
    ].join("\n\n");
    secondAnswer.text = "Second reply\n\n![Second image](./render.png)";
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
      { authenticated: true },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const target = new URL(url);
    target.searchParams.set("session", "first");
    await page.goto(target.href);
    await page.getByText("First reply", { exact: true }).waitFor();
    const image = page.getByRole("img", { name: "First image", exact: true });
    await image.evaluate((element: HTMLImageElement) => element.decode());
    assert.equal(await image.evaluate((element: HTMLImageElement) => element.naturalWidth), 32);
    const firstSrc = await image.getAttribute("src");
    assert.ok(firstSrc);
    const load = new URL(firstSrc).searchParams.get("load");
    assert.ok(load);
    await page.getByRole("button", { name: "Image preview", exact: true }).hover();
    const preview = page.getByRole("img", { name: "./render.png", exact: true });
    await preview.waitFor();
    await preview.evaluate((element: HTMLImageElement) => element.decode());
    const previewSrc = await preview.getAttribute("src");
    assert.ok(previewSrc);
    assert.ok(new URL(previewSrc).searchParams.get("load"));
    assert.equal(await preview.evaluate((element: HTMLImageElement) => element.naturalWidth), 32);
    await page.mouse.move(0, 0);
    assert.equal(
      await page
        .getByRole("link", { name: "https://example.com/a", exact: true })
        .getAttribute("href"),
      "https://example.com/a",
    );
    assert.equal(
      await page
        .getByRole("link", { name: "https://example.org/b", exact: true })
        .getAttribute("href"),
      "https://example.org/b",
    );
    assert.equal(
      await page.getByRole("link", { name: "Explicit URL", exact: true }).getAttribute("href"),
      "https://example.net/%E3%80%82%F0%9F%98%80",
    );

    for (const [name, line] of [
      ["Line range", 24],
      ["Line column", 50],
    ] as const) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.locator(`[data-textpreview-target="${line}"]`).waitFor();
    }
    assert.equal(
      await image.getAttribute("src"),
      firstSrc,
      "UI rerenders must not force image reloads",
    );

    // A different real PNG at the same path, without reloading the browser document.
    writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const folder = page
      .getByRole("treeitem")
      .filter({ hasText: new RegExp(`^${basename(workspace)}$`) })
      .first();
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key="session:second"]').click();
    const fresh = page.getByRole("img", { name: "Second image", exact: true });
    await fresh.waitFor();
    await fresh.evaluate((element: HTMLImageElement) => element.decode());
    assert.equal(await fresh.evaluate((element: HTMLImageElement) => element.naturalWidth), 1);
    assert.notEqual(await fresh.getAttribute("src"), firstSrc);
    await page.locator('[data-row-key="session:first"]').click();
    await image.waitFor();
    await image.evaluate((element: HTMLImageElement) => element.decode());
    assert.equal(await image.evaluate((element: HTMLImageElement) => element.naturalWidth), 1);
    assert.notEqual(await image.getAttribute("src"), firstSrc);
    assert.deepEqual(errors, []);
    assert.equal(
      host.requests.some((request) => ["turn/start", "thread/resume"].includes(request.method)),
      false,
    );
  },
);
