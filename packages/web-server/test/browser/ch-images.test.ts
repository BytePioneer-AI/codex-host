import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { PNG } from "../support/image.ts";

async function shot(page: Page, name: string) {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, name + ".png") });
}

for (const mobile of [false, true]) {
  it(
    `shared image ${mobile ? "picker on touch" : "clipboard paste"} saves a native path and restores previews`,
    { timeout: 60_000 },
    async (t) => {
      const host = new FakeChHost();
      host.add("existing", "/computer/images", "Existing image thread");
      const native = host.request.bind(host);
      let reject = false,
        attempts = 0;
      let expectedBytes = Buffer.from(PNG, "base64");
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (method === "turn/start") {
          attempts++;
          if (reject) throw new Error("Native image refusal");
          const input = params.input as Array<{ type: string; text: string }>;
          assert.ok(input.every((part) => part.type === "text"));
          const path = /## image-1.png: (.+)\n/u.exec(input[0]?.text ?? "")?.[1];
          assert.ok(path);
          assert.deepEqual(readFileSync(path), expectedBytes);
        }
        const result = await native<T>(method, params);
        if (method === "turn/start") {
          const turn = host.threads.get(String(params.threadId))?.turns.at(-1);
          const answer = turn?.items.find((item) => item.type === "agentMessage");
          assert.ok(answer);
          answer.text = "Image path accepted";
        }
        return result;
      };
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
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        permissions: mobile ? [] : ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      if (!mobile) {
        // Test setup only: seed this isolated browser's clipboard. The operation under test is a real keyboard paste.
        const clipboardData = await page.evaluate(async (data) => {
          const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) }),
          ]);
          // Chromium may re-encode PNG clipboard pixels. Preserve the bytes actually pasted,
          // not the pre-clipboard fixture's compression/metadata.
          const items = await navigator.clipboard.read();
          const blob = await items[0]?.getType("image/png");
          if (!blob) throw new Error("Image clipboard setup failed");
          return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
        }, PNG);
        expectedBytes = Buffer.from(clipboardData, "base64");
        t.diagnostic(
          `Clipboard PNG re-encoded by browser: ${!expectedBytes.equals(Buffer.from(PNG, "base64"))}`,
        );
      }
      const composer = page.locator('[data-composer-card] [contenteditable="true"]');
      const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
      const add = async () => {
        if (mobile) {
          await page
            .getByRole("button", { name: "Add files or run commands", exact: true })
            .click();
          const chooser = page.waitForEvent("filechooser");
          await page.getByRole("option", { name: /^File\b/u }).click();
          await (
            await chooser
          ).setFiles({
            name: "clipboard-test.png",
            mimeType: "image/png",
            buffer: Buffer.from(PNG, "base64"),
          });
        } else {
          await composer.click();
          await page.keyboard.press("ControlOrMeta+V");
        }
        await pending.locator("img").waitFor();
        await page.waitForFunction(() => {
          const image = document.querySelector<HTMLImageElement>(
            '[aria-label="Pending attachments"] img',
          );
          return image?.complete && image.naturalWidth === 32;
        });
      };
      await shot(page, `image-${mobile ? "touch" : "desktop"}-before`);
      await add();
      await composer.fill("Inspect this image");
      assert.equal(
        host.requests.some((r) => r.method === "thread/start"),
        false,
        "intake does not create a native session",
      );
      await shot(page, `image-${mobile ? "touch" : "desktop"}-draft`);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("Image path accepted", { exact: true }).waitFor();
      await pending.waitFor({ state: "detached" });
      const preview = page.getByRole("button", { name: /click to view original/u }).first();
      await preview.waitFor();
      assert.equal(attempts, 1);
      await shot(page, `image-${mobile ? "touch" : "desktop"}-sent`);
      await page.reload();
      await preview.waitFor();
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll<HTMLImageElement>(
            'button[aria-label*="click to view original"] img',
          ),
        ].some((image) => image.complete && image.naturalWidth === 32),
      );
      await shot(page, `image-${mobile ? "touch" : "desktop"}-restored`);
      // Rejection after binding: retain the draft image and text, without automatic resubmission.
      reject = true;
      await add();
      await composer.fill("Keep this image if refused");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText(/Native image refusal/u).waitFor();
      await pending.locator("img").waitFor();
      assert.match(await composer.innerText(), /Keep this image if refused/u);
      assert.equal(attempts, 2);
      await shot(page, `image-${mobile ? "touch" : "desktop"}-refused`);
      await page.getByRole("button", { name: /^Remove image /u }).click();
      await pending.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
    },
  );
}
