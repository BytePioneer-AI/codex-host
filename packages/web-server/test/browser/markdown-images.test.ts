import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { PNG } from "../support/image.ts";

for (const mobile of [false, true]) {
  it(
    `Markdown images load, enlarge and survive reload (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "web-markdown-images-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, "图片 with spaces.png");
      writeFileSync(path, Buffer.from(PNG, "base64"));
      const host = new FakeChHost();
      const row = host.add("images", root, "Output images");
      const answer = row.turns[0]?.items.at(-1);
      assert.ok(answer);
      answer.text = [
        "Output image answer",
        `![Absolute image](${encodeURI(path)})`,
        `![Relative image](${encodeURI("图片 with spaces.png")})`,
        `![File URL image](${pathToFileURL(path).href})`,
      ].join("\n\n");
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
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      if (mobile) await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
      const folder = page
        .getByRole("treeitem")
        .filter({ hasText: new RegExp(`^${root.split("/").at(-1)}$`) });
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator('[data-row-key="session:images"]').click();

      for (const reloaded of [false, true]) {
        if (reloaded) await page.reload();
        await page.getByText("Output image answer", { exact: true }).waitFor();
        for (const alt of ["Absolute image", "Relative image", "File URL image"]) {
          const image = page.getByRole("img", { name: alt, exact: true });
          await image.waitFor();
          await image.evaluate(async (element: HTMLImageElement) => {
            await element.decode();
          });
          assert.equal(
            await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
            32,
          );
        }
        await page
          .getByRole("button", { name: "View full image: Absolute image", exact: true })
          .click();
        await page.getByRole("dialog", { name: "Image preview", exact: true }).waitFor();
        await page.getByRole("button", { name: "Close image preview", exact: true }).click();
      }
      assert.deepEqual(errors, []);
      assert.equal(
        host.requests.some((request) => ["turn/start", "thread/resume"].includes(request.method)),
        false,
      );
    },
  );
}
