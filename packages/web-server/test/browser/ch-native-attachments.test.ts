import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { nativeImageInput, PNG } from "../support/image.ts";

async function shot(page: Page, name: string) {
  // Observe settled geometry; a native history read can finish while the existing
  // phone drawer is still animating out of the way.
  await page.waitForFunction(() => {
    const phone = document.querySelector("[data-phone]");
    if (!phone) return true;
    const drawer = phone.querySelector('[class*="phoneDrawer"]');
    return (
      phone.hasAttribute("data-sidebar-collapsed") &&
      !!drawer &&
      drawer.getBoundingClientRect().right <= 0.5
    );
  });
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, name + ".png") });
}

for (const mobile of [false, true]) {
  it(
    `native Desktop image/file history renders in Web (${mobile ? "touch" : "desktop"})`,
    { timeout: 60_000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "web-native-attachments-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const path = join(root, "codex-clipboard-56c36986-6e9d-425b-9918-c06b13abdc72.png");
      writeFileSync(path, Buffer.from(PNG, "base64"));
      const input = nativeImageInput(path, "Question sent from Desktop", "Desktop screenshot.png");
      const first = input[0];
      assert.ok(first);
      first.text = first.text.replace(
        "\nDistinguish",
        "\n## notes.md: /workspace/notes.md (line 5)\n\nDistinguish",
      );
      const host = new FakeChHost();
      const native = host.add("desktop", "/computer/images", "Desktop image thread");
      const nativeUser = native.turns[0]?.items[0];
      const nativeAnswer = native.turns[0]?.items[1];
      assert.ok(nativeUser && nativeAnswer);
      nativeUser.content = input;
      nativeAnswer.text = "Native attachment history loaded";
      const unavailable = host.add("unavailable", "/computer/images", "Missing Desktop image");
      const missingUser = unavailable.turns[0]?.items[0];
      assert.ok(missingUser);
      missingUser.content = nativeImageInput(
        join(root, "missing.png"),
        "Keep the user's question",
        "Missing screenshot.png",
      );
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
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Preparation is complete. All page actions below are ordinary GUI operations.
      await page.goto(url);
      await page.getByText("Native Model", { exact: true }).waitFor();
      const openSidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
      if (mobile) await openSidebar.first().click();
      const folder = page.getByRole("treeitem").filter({ hasText: /^images$/u });
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator('[data-row-key="session:desktop"]').click();
      await page.getByText("Question sent from Desktop", { exact: true }).waitFor();
      await page.getByText("Native attachment history loaded", { exact: true }).waitFor();
      const photo = page.getByRole("button", {
        name: "Desktop screenshot.png, click to view original",
        exact: true,
      });
      await photo.waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>("[data-message-attachments] img");
        return image?.complete && image.naturalWidth === 32;
      });
      const body = page.locator("[data-conversation-scroll]");
      assert.equal((await body.innerText()).includes("# Files mentioned"), false);
      assert.equal((await body.innerText()).includes("Image attachment: true"), false);
      assert.equal((await body.innerText()).includes("Distinguish instructions"), false);
      await body.getByText("notes.md", { exact: true }).waitFor();
      assert.equal(
        (await body.innerText()).includes("0B"),
        false,
        "native file size is unknown, not zero",
      );
      await shot(page, `native-${mobile ? "touch" : "desktop"}-history`);
      await photo.click();
      const lightbox = page.getByRole("dialog", { name: "Original image preview", exact: true });
      await lightbox.waitFor();
      assert.equal(
        await lightbox.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth),
        32,
      );
      await shot(page, `native-${mobile ? "touch" : "desktop"}-original`);
      await page.getByRole("button", { name: "Close original image preview", exact: true }).click();
      await lightbox.waitFor({ state: "detached" });
      await page.reload();
      await photo.waitFor();
      await shot(page, `native-${mobile ? "touch" : "desktop"}-reloaded`);
      if (mobile) await openSidebar.last().click();
      await page.locator('[data-row-key="session:unavailable"]').click();
      await page.getByText("Keep the user's question", { exact: true }).waitFor();
      const failure = page.getByRole("button", {
        name: "Image unavailable; click to retry",
        exact: true,
      });
      await failure.waitFor();
      assert.equal((await body.innerText()).includes("# Files mentioned"), false);
      await shot(page, `native-${mobile ? "touch" : "desktop"}-missing`);
      await failure.click();
      await failure.waitFor();
      await shot(page, `native-${mobile ? "touch" : "desktop"}-retry`);
      assert.equal(
        host.requests.some((request) =>
          ["turn/start", "thread/start", "thread/resume"].includes(request.method),
        ),
        false,
        "reading native attachments never sends or resumes a Thread",
      );
      assert.deepEqual(errors, []);
    },
  );
}
