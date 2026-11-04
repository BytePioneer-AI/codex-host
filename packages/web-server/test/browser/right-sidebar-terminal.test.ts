import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "uses the official duplex terminal model for desktop input, bursts, recovery and mobile home drafts",
  { timeout: 90_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "codexhost-terminal-browser-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("local-thread", workspace, "Local Thread");
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
      { environment: { ...process.env, SHELL: "/bin/sh" } },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    const legacyWrites: string[] = [];
    let attachments = 0;
    let inputs = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/\/api\/terminal\/(write|resize|follow)$/u.test(request.url()))
        legacyWrites.push(request.url());
    });
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload)) as {
          type?: string;
          endpoint?: string;
          value?: { type?: string };
        };
        if (frame.endpoint === "terminal/attach") attachments++;
        if (frame.type === "item" && frame.value?.type === "write") inputs++;
      }),
    );
    const target = new URL(url);
    target.searchParams.set("session", "local-thread");
    await page.goto(target.href);
    await page.getByText("earlier question", { exact: true }).waitFor();
    await page.locator("[data-sidebar-right-expand]").click();
    await page.locator('[data-sidebar-right-guide-entry="terminal"] button').first().click();
    const textarea = page.locator(".xterm-helper-textarea");
    await textarea.waitFor();
    await page.locator(".xterm-rows").filter({ hasText: /[$#>]/u }).waitFor();
    await textarea.focus();
    // insertText exercises an input-only commit, not a synthetic desktop keydown.
    await page.keyboard.insertText("printf '%s' '一二三四五六七八九十abcdefghij' > received.txt");
    await page.keyboard.press("Enter");
    const waitForFile = async (name: string, expected: string) => {
      const path = join(workspace, name);
      const deadline = Date.now() + 20_000;
      while (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
        if (Date.now() > deadline)
          throw new Error(`Terminal command did not produce ${name}: ${errors.join("; ")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitForFile("received.txt", "一二三四五六七八九十abcdefghij");
    // Short-key frames have much greater encoded size than their raw text. The
    // upstream model must preserve their order and the trailing Enter.
    const burst = "a".repeat(3000);
    await page.keyboard.type(`printf '%s' '${burst}' > burst.txt`);
    await page.keyboard.press("Enter");
    await waitForFile("burst.txt", burst);
    assert.ok(inputs > 3000);
    assert.equal(attachments, 1);
    assert.deepEqual(legacyWrites, []);
    await page.keyboard.insertText("printf 'RECOVERY_%s\\n' PROOF");
    await page.keyboard.press("Enter");
    await page.locator(".xterm-rows").filter({ hasText: "RECOVERY_PROOF" }).waitFor();
    await page.reload();
    await page.locator(".xterm-rows").filter({ hasText: "RECOVERY_PROOF" }).waitFor();
    assert.equal(attachments, 2);
    await textarea.focus();
    await page.keyboard.insertText("printf '%s' resumed > resumed.txt");
    await page.keyboard.press("Enter");
    await waitForFile("resumed.txt", "resumed");

    // A fresh mobile draft without a workspace can open a home-directory
    // terminal without allocating a Harness Thread or assigning a workspace.
    const draftPage = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    });
    draftPage.on("pageerror", (error) => errors.push(error.message));
    await draftPage.goto(url);
    // The compact mobile trigger keeps its loaded model label in the DOM but hides the text.
    await draftPage.getByText("Native Model", { exact: true }).waitFor({ state: "attached" });
    await draftPage.waitForLoadState("networkidle");
    await draftPage.locator("[data-sidebar-right-expand]").click();
    await draftPage.locator('[data-sidebar-right-guide-entry="terminal"] button').first().click();
    await draftPage.locator(".xterm-rows").filter({ hasText: /[$#>]/u }).waitFor();
    await draftPage
      .getByRole("textbox", { name: "Terminal input draft" })
      .fill("printf 'HOME_CWD<%s>\\n' \"$PWD\"");
    await draftPage.getByRole("button", { name: "Insert and Enter", exact: true }).click();
    await draftPage
      .locator(".xterm-rows")
      .filter({ hasText: `HOME_CWD<${homedir()}>` })
      .waitFor();
    assert.equal(
      host.requests.some(({ method }) => method === "thread/start"),
      false,
    );
    assert.deepEqual(errors, []);
  },
);
