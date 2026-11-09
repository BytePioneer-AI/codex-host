import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "preserves Markdown reading position across paged refresh and keeps code line navigation",
  { timeout: 90_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "document-preview-refresh-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const path = join(workspace, "reading.md");
    // The workspace reader serves at most 5,000 source lines per page.
    const markdown =
      "# Before refresh\n\n" +
      Array.from({ length: 2700 }, (_, index) => `Paragraph ${index + 1}\n`).join("\n");
    writeFileSync(path, markdown);
    writeFileSync(
      join(workspace, "code.ts"),
      Array.from({ length: 100 }, (_, index) => `// Line ${index + 1}`).join("\n"),
    );
    const host = new FakeChHost();
    const thread = host.add("reading", workspace, "Reading position");
    const answer = thread.turns[0]?.items.at(-1);
    assert.ok(answer);
    answer.text = "[Reading](reading.md#L10) [Code line](code.ts#L50)";
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const target = new URL(url);
    target.searchParams.set("session", "reading");
    await page.goto(target.href);
    await page.getByRole("button", { name: "Reading", exact: true }).click();
    const preview = page.locator("[data-textpreview-url]");
    const body = preview.locator("[data-textpreview-body]");
    const heading = body.getByRole("heading", { level: 1 });
    await heading.waitFor();
    assert.equal(await heading.textContent(), "Before refresh");
    assert.equal(await body.evaluate((node) => getComputedStyle(node).overflowAnchor), "none");
    const offset = await body.evaluate((node) => node.scrollHeight + 100);
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForFunction((top) => {
      const node = document.querySelector("[data-textpreview-body]");
      return node !== null && node.scrollHeight - node.clientHeight > top;
    }, offset);
    await body.evaluate(
      (node, top) =>
        new Promise<void>((done) => {
          node.addEventListener("scroll", () => done(), { once: true });
          node.scrollTop = top;
        }),
      offset,
    );
    assert.equal(await body.evaluate((node) => node.scrollTop), offset);

    // Changes above the viewport must keep a pixel offset, not a browser anchor.
    await heading.evaluate((node) => {
      node.style.paddingTop = "300px";
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    assert.equal(await body.evaluate((node) => node.scrollTop), offset);
    await heading.evaluate((node) => {
      node.style.paddingTop = "";
    });

    writeFileSync(path, markdown.replace("Before refresh", "After refresh"));
    await body.getByRole("heading", { name: "After refresh", exact: true }).waitFor();
    const restored = async () =>
      page.waitForFunction((top) => {
        const node = document.querySelector("[data-textpreview-body]");
        return node !== null && Math.abs(node.scrollTop - top) <= 1;
      }, offset);
    await restored();
    const oldHeading = await heading.elementHandle();
    assert.ok(oldHeading);
    await preview.locator('[data-textpreview-tool="reload"]').click();
    await page.waitForFunction((node) => !node.isConnected, oldHeading);
    await body.getByRole("heading", { name: "After refresh", exact: true }).waitFor();
    await restored();
    await oldHeading.dispose();

    await page.getByRole("button", { name: "Code line", exact: true }).click();
    await page.locator("[data-code-preview]").waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector("[data-code-preview] [data-code-block-content]");
      const line = node?.querySelectorAll("pre .line").item(49);
      return (
        node !== null &&
        line instanceof HTMLElement &&
        line.offsetTop > 0 &&
        Math.abs(node.scrollTop - line.offsetTop) <= 1
      );
    });
    assert.deepEqual(errors, []);
    assert.equal(
      host.requests.some((request) => ["turn/start", "thread/resume"].includes(request.method)),
      false,
    );
  },
);
