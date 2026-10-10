import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { PNG } from "../support/image.ts";
async function shot(page: Page, name: string) {
  if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
    mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, name + ".png") });
  }
}

for (const mobile of [false, true])
  it(
    `arbitrary file picker stages bytes and shares native path history (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const fixtures = [
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("A note\n") },
        {
          name: "report.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("opaque PDF fixture"),
        },
        { name: "archive.zip", mimeType: "application/zip", buffer: Buffer.from([0, 255, 42, 10]) },
        { name: "empty.xyz", mimeType: "application/octet-stream", buffer: Buffer.alloc(0) },
        { name: "image.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") },
      ];
      const host = new FakeChHost();
      host.add("existing", "/computer/files", "Existing file thread");
      const native = host.request.bind(host);
      let refusal = false,
        attempts = 0;
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (method === "turn/start") {
          attempts++;
          if (refusal) throw new Error("Native file refusal");
          const input = params.input as Array<{ type: string; text: string }>;
          assert.ok(input.every((part) => part.type === "text"));
          for (const file of fixtures.slice(0, 4)) {
            const match = input[0]?.text
              .split("\n")
              .find((line) => line.startsWith(`## ${file.name}: `));
            assert.ok(match);
            assert.deepEqual(readFileSync(match.slice(`## ${file.name}: `.length)), file.buffer);
          }
        }
        const result = await native<T>(method, params);
        if (method === "turn/start") {
          const answer = host.threads
            .get(String(params.threadId))
            ?.turns.at(-1)
            ?.items.find((item) => item.type === "agentMessage");
          assert.ok(answer);
          answer.text = "Native files accepted";
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
      });
      // Network-fixture setup: make the real background upload gate observable.
      await context.route("**/api/session/uploadFileBinary?*", async (route) => {
        await new Promise((done) => setTimeout(done, 350));
        await route.continue();
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
      const add = async () => {
        await page.getByRole("button", { name: "Add files or run commands", exact: true }).click();
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("option", { name: /^File\b/u }).click();
        await (await chooser).setFiles(fixtures);
      };
      await add();
      await pending.getByText("notes.txt", { exact: true }).waitFor();
      const composer = page.locator('[data-composer-card] [contenteditable="true"]');
      await composer.fill("Review all attachments");
      const send = page.getByRole("button", { name: "Send message", exact: true });
      assert.equal(await send.isDisabled(), true, "send waits for streamed uploads");
      assert.equal(
        host.requests.some((r) => r.method === "thread/start"),
        false,
      );
      await shot(page, `files-${mobile ? "touch" : "desktop"}-uploading`);
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Send message"]',
        );
        return button && !button.disabled;
      });
      await shot(page, `files-${mobile ? "touch" : "desktop"}-ready`);
      await send.click();
      await page.getByText("Native files accepted", { exact: true }).waitFor();
      await pending.waitFor({ state: "detached" });
      const body = page.locator("[data-conversation-scroll]");
      for (const file of fixtures.slice(0, 4))
        await body.getByText(file.name, { exact: true }).waitFor();
      assert.equal((await body.innerText()).includes("# Files mentioned"), false);
      assert.equal(attempts, 1);
      await shot(page, `files-${mobile ? "touch" : "desktop"}-sent`);
      await page.reload();
      await body.getByText("archive.zip", { exact: true }).waitFor();
      await shot(page, `files-${mobile ? "touch" : "desktop"}-restored`);
      refusal = true;
      await add();
      await composer.fill("Keep these if refused");
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Send message"]',
        );
        return button && !button.disabled;
      });
      await send.click();
      await page.getByText(/Native file refusal/u).waitFor();
      await pending.getByText("notes.txt", { exact: true }).waitFor();
      assert.match(await composer.innerText(), /Keep these if refused/u);
      assert.equal(attempts, 2);
      await shot(page, `files-${mobile ? "touch" : "desktop"}-refused`);
      assert.deepEqual(errors, []);
    },
  );
