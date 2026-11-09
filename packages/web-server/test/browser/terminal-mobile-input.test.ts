import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "edits mobile text locally and sends acknowledged drafts through the real PTY",
  { timeout: 90_000 },
  async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "mobile-terminal-editor-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("thread", workspace, "Mobile terminal");
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
    for (const profile of [
      {
        name: "iphone",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      },
      {
        name: "android",
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36",
      },
    ]) {
      const context = await browser.newContext({
        viewport: { width: profile.name === "android" ? 360 : 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        userAgent: profile.userAgent,
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const writes: string[] = [];
        let refuseNextWrite = false;
        let refusal: string | undefined;
        let refusedStream: string | undefined;
        let holdNextWrite = false;
        let holdKey: string | undefined;
        let held: Array<string | Buffer> = [];
        let releaseHeld = (): void => {};
        await page.routeWebSocket("**/api/remote.mux", (route) => {
          const server = route.connectToServer();
          let holding = false;
          releaseHeld = () => {
            holding = false;
            for (const message of held) route.send(message);
            held = [];
          };
          route.onMessage((message) => {
            const frame = JSON.parse(String(message));
            if (frame.type === "item" && frame.value?.type === "write") {
              writes.push(frame.value.data);
              if (holdNextWrite) {
                holdKey = `${frame.streamId}/${frame.value.sequence}`;
                holdNextWrite = false;
              }
              if (refuseNextWrite) {
                refusal = `${frame.streamId}/${frame.value.sequence}`;
                refuseNextWrite = false;
              }
            }
            server.send(message);
          });
          server.onMessage((message) => {
            const frame = JSON.parse(String(message));
            if (
              frame.value?.type === "ack" &&
              `${frame.streamId}/${frame.value.sequence}` === holdKey
            ) {
              holdKey = undefined;
              holding = true;
            }
            if (holding) {
              held.push(message);
              return;
            }
            if (
              frame.value?.type === "ack" &&
              `${frame.streamId}/${frame.value.sequence}` === refusal
            ) {
              refusal = undefined;
              frame.value.refusal = "read-only";
              refusedStream = frame.streamId;
              route.send(JSON.stringify(frame));
            } else if (
              frame.streamId === refusedStream &&
              frame.value &&
              "writable" in frame.value
            ) {
              frame.value.writable = false;
              route.send(JSON.stringify(frame));
            } else route.send(message);
          });
        });
        const target = new URL(url);
        target.searchParams.set("session", "thread");
        await page.goto(target.href);
        await page.getByText("earlier question", { exact: true }).waitFor();
        await page.waitForLoadState("networkidle");
        await page.locator("[data-sidebar-right-expand]").click();
        await page
          .locator('[data-sidebar-right-guide-entry="terminal"] button')
          .first()
          .click({ position: { x: 16, y: 16 } });
        const editor = page.getByRole("textbox", { name: "Terminal input draft", exact: true });
        const enterMode = page.getByRole("group", { name: "Keyboard Enter", exact: true });
        const insertMode = enterMode.getByRole("button", { name: "Insert only", exact: true });
        const sendMode = enterMode.getByRole("button", { name: "Send + Enter", exact: true });
        const enterAction = page.getByRole("button", { name: /^(Insert and Enter|Enter)$/u });
        await editor.waitFor();
        await page.locator(".xterm-rows").filter({ hasText: /[$#>]/u }).waitFor();
        assert.equal(
          await page.locator(".xterm-helper-textarea").getAttribute("inputmode"),
          "none",
        );
        assert.equal(
          await page
            .locator(".xterm-helper-textarea")
            .evaluate((node) => (node as HTMLTextAreaElement).readOnly),
          true,
        );
        const controls = page.getByRole("group", { name: "Terminal control keys", exact: true });
        const strip = page.locator("[data-terminal-key-strip]");
        assert.equal(await controls.locator('[aria-haspopup="menu"]').count(), 0);
        const layout = await controls.evaluate((node) => {
          const strip = node.querySelector<HTMLElement>("[data-terminal-key-strip]");
          if (!strip) throw new Error("Missing terminal key strip");
          return {
            rows: [...node.querySelectorAll("button")].map((button) =>
              Math.round(button.getBoundingClientRect().top),
            ),
            count: node.querySelectorAll("button").length,
            overflows: strip.scrollWidth > strip.clientWidth,
            overflowX: getComputedStyle(strip).overflowX,
            fits: node.scrollWidth <= node.clientWidth,
          };
        });
        assert.equal(layout.count, 11, "mode switch and all control keys share one row");
        assert.equal(layout.fits, true, "only the key strip overflows, not the composer");
        assert.equal(new Set(layout.rows).size, 1);
        assert.equal(layout.overflows, true);
        assert.equal(layout.overflowX, "auto");
        const bounds = await strip.boundingBox();
        const modeBeforeSwipe = await enterMode.boundingBox();
        assert.ok(bounds);
        const beforeSwipe = writes.length;
        const touch = await context.newCDPSession(page);
        const y = bounds.y + bounds.height / 2;
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: bounds.x + bounds.width - 12, y }],
        });
        for (let offset = 40; offset < 240; offset += 40) {
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: bounds.x + bounds.width - offset, y }],
          });
        }
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForFunction(
          () => (document.querySelector("[data-terminal-key-strip]")?.scrollLeft ?? 0) > 0,
        );
        await touch.detach();
        assert.equal(
          writes.length,
          beforeSwipe,
          "swiping across buttons must not send a control key",
        );
        assert.deepEqual(
          await enterMode.boundingBox(),
          modeBeforeSwipe,
          "mode switch stays in place while keys scroll",
        );
        await strip.evaluate((node) => {
          node.scrollLeft = 0;
        });

        // Safari can shrink only visualViewport when its software keyboard opens.
        const viewportState = await page.evaluateHandle(() => {
          const viewport = window.visualViewport;
          if (!viewport) throw new Error("Missing visual viewport");
          const previous = Object.getOwnPropertyDescriptor(viewport, "height");
          Object.defineProperty(viewport, "height", { configurable: true, value: 420 });
          viewport.dispatchEvent(new Event("resize"));
          return previous;
        });
        await page.waitForFunction(() => {
          const viewport = window.visualViewport;
          const editor = document.querySelector("[data-terminal-composer]");
          return (
            viewport &&
            editor &&
            editor.getBoundingClientRect().bottom <= viewport.offsetTop + viewport.height + 1
          );
        });
        assert.ok(await editor.evaluate((node) => node.getBoundingClientRect().height >= 40));
        await viewportState.evaluate((previous) => {
          const viewport = window.visualViewport;
          if (!viewport) return;
          if (previous) Object.defineProperty(viewport, "height", previous);
          else Reflect.deleteProperty(viewport, "height");
          viewport.dispatchEvent(new Event("resize"));
        });
        await viewportState.dispose();
        const compactHeight = await editor.evaluate((node) => node.getBoundingClientRect().height);
        await editor.fill("one\ntwo\nthree\nfour\nfive");
        const expandedHeight = await editor.evaluate((node) => node.getBoundingClientRect().height);
        assert.ok(expandedHeight > compactHeight && expandedHeight <= 120);
        await editor.fill("");
        assert.equal(
          await editor.evaluate((node) => node.getBoundingClientRect().height),
          compactHeight,
        );
        assert.ok(
          await page
            .locator("[data-terminal-composer]")
            .evaluate((node) => node.getBoundingClientRect().height < 130),
          "idle composer leaves space for terminal output",
        );
        const received = writes.length;
        assert.equal(await sendMode.getAttribute("aria-pressed"), "true");
        await editor.focus();
        await insertMode.click();
        assert.equal(await insertMode.getAttribute("aria-pressed"), "true");
        assert.equal(await editor.getAttribute("enterkeyhint"), "enter");
        assert.equal(await editor.evaluate((node) => node === document.activeElement), true);
        assert.equal(writes.length, received, "choosing a mode does not send input");
        await editor.evaluate((node) =>
          node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
        );
        await editor.fill("nihao");
        assert.equal(
          await enterAction.isDisabled(),
          true,
          "candidate selection cannot submit a command",
        );
        const text = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸中文连续输入完整保留abcdefghij🙂";
        await editor.fill(text);
        await editor.evaluate((node) =>
          node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
        );
        await editor.press("Shift+Enter");
        assert.equal(await editor.inputValue(), text + "\n");
        await editor.press("Backspace");
        assert.equal(
          writes.length,
          received,
          "typing, candidate replacement and Shift+Enter stay local",
        );

        // A remounted tab retains its raw local draft without sending it.
        const tabId = await page
          .locator('[data-dockkit-tab][aria-selected="true"]')
          .getAttribute("data-dockkit-tab");
        assert.ok(tabId);
        await page.locator("[data-dockkit-add-tab]").click();
        await page.locator(`[data-dockkit-tab="${tabId}"]`).click();
        await editor.waitFor();
        assert.equal(await editor.inputValue(), text);
        assert.equal(
          await insertMode.getAttribute("aria-pressed"),
          "true",
          "mode survives tab remount",
        );
        assert.equal(writes.length, received);

        const name = `${profile.name}.txt`;
        const command = `printf '%s' '${text}' > ${name}`;
        await editor.fill(command);
        await editor.evaluate((node) =>
          node.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: "insertLineBreak",
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLTextAreaElement>("[data-terminal-composer] textarea")
              ?.value === "",
        );
        assert.equal(writes.at(-1), command, "the full native editor value is sent once");
        assert.equal(
          existsSync(join(workspace, name)),
          false,
          "inserting text alone does not execute it",
        );
        const beforeEmptyEnter = writes.length;
        await editor.press("Enter");
        assert.equal(
          writes.length,
          beforeEmptyEnter,
          "insert-only Enter with an empty draft is a no-op",
        );
        await sendMode.click();
        assert.equal(await sendMode.getAttribute("aria-pressed"), "true");
        assert.equal(
          writes.length,
          beforeEmptyEnter,
          "switching modes does not execute pending terminal text",
        );
        assert.equal(await editor.getAttribute("enterkeyhint"), "send");
        await editor.press("Enter");
        const deadline = Date.now() + 10_000;
        while (
          !existsSync(join(workspace, name)) ||
          readFileSync(join(workspace, name), "utf8") !== text
        ) {
          if (Date.now() > deadline) throw new Error("Mobile command did not execute");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(readFileSync(join(workspace, name), "utf8"), text);

        // Soft keyboards can submit with only beforeinput, without keydown.
        const softName = `${profile.name}-soft-enter.txt`;
        const softCommand = `printf '%s' '手机回车abcdefghij' > ${softName}`;
        await editor.fill(softCommand);
        const beforeSoftEnter = writes.length;
        await editor.evaluate((node) =>
          node.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: "insertParagraph",
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLTextAreaElement>("[data-terminal-composer] textarea")
              ?.value === "",
        );
        assert.deepEqual(
          writes.slice(beforeSoftEnter),
          [softCommand, "\r"],
          "soft Enter submits text then exactly one terminal Enter",
        );
        const softDeadline = Date.now() + 10_000;
        while (
          !existsSync(join(workspace, softName)) ||
          readFileSync(join(workspace, softName), "utf8") !== "手机回车abcdefghij"
        ) {
          if (Date.now() > softDeadline) throw new Error("Soft keyboard command did not execute");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
          mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
          await editor.fill("帮我检查一下这段代码…");
          await page.screenshot({
            path: join(
              process.env.CODEXHOST_TEST_SCREENSHOTS,
              `terminal-${profile.name}-composer.png`,
            ),
          });
          await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
          await page.locator("body[data-ds-dark-theme]").waitFor();
          await page.screenshot({
            path: join(
              process.env.CODEXHOST_TEST_SCREENSHOTS,
              `terminal-${profile.name}-composer-dark.png`,
            ),
          });
          await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
          await page.locator("body:not([data-ds-dark-theme])").waitFor();
        }

        // Native selection/replacement stays local, rather than sending guessed DELs.
        await editor.fill("teh");
        await editor.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(0, 3));
        await page.keyboard.insertText("the");
        assert.equal(await editor.inputValue(), "the");
        const beforeMultiline = writes.length;
        await page.locator("[data-terminal-mobile]").evaluate((node) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", " 粘贴\ntext");
          node.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
          );
        });
        assert.equal(await editor.inputValue(), "the 粘贴\ntext");
        assert.equal(
          writes.length,
          beforeMultiline,
          "pasting onto the terminal edits the local draft",
        );
        await editor.fill("first\nsecond");
        await editor.press("Enter");
        await page.getByText(/Multiple lines may execute commands immediately/u).waitFor();
        assert.equal(writes.length, beforeMultiline);
        await editor.fill("local draft");
        const beforeScroll = writes.length;
        await strip.evaluate((node) => {
          node.scrollLeft = node.scrollWidth;
        });
        const eof = strip.getByRole("button", { name: "Ctrl+D", exact: true });
        assert.equal(await eof.isEnabled(), true);
        assert.equal(
          await eof.evaluate((node) => {
            const parent = node.parentElement;
            return (
              parent !== null &&
              node.getBoundingClientRect().right <= parent.getBoundingClientRect().right + 1
            );
          }),
          true,
          "scrolling reveals the final key without a menu",
        );
        assert.equal(writes.length, beforeScroll, "scrolling does not activate a key");
        await strip.getByRole("button", { name: "Terminal backspace", exact: true }).click();
        assert.equal(writes.at(-1), "\x7f");
        assert.equal(await editor.inputValue(), "local draft");
        assert.equal(await editor.evaluate((node) => node === document.activeElement), true);
        await page.getByRole("button", { name: "Ctrl+C", exact: true }).click();
        assert.equal(await editor.inputValue(), "local draft");
        assert.equal(writes.at(-1), "\x03");
        await editor.fill("");
        await page.getByRole("button", { name: "Terminal up", exact: true }).click();
        assert.equal(writes.at(-1), "\x1b[A");
        await page.getByRole("button", { name: "Ctrl+C", exact: true }).click();

        // The explicit terminal Enter remains available in insert-only mode.
        await insertMode.click();
        await enterAction.click();
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLTextAreaElement>("[data-terminal-composer] textarea")
              ?.readOnly,
        );
        assert.equal(writes.at(-1), "\r");
        await sendMode.click();

        // A lost/refused receipt must retain the draft and must never auto-replay.
        const uncertain = "printf 'delivery uncertain'";
        await editor.fill(uncertain);
        refuseNextWrite = true;
        await editor.press("Enter");
        await page.getByText(/Acknowledgement was not received/u).waitFor();
        assert.equal(await editor.inputValue(), uncertain);
        assert.equal(await enterAction.isDisabled(), true);
        const beforeReconnect = writes.length;
        await page.getByRole("button", { name: "Take control", exact: true }).click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLButtonElement>("[data-terminal-composer] button")].some(
            (button) =>
              button.getAttribute("aria-label") === "Insert and Enter" && !button.disabled,
          ),
        );
        assert.equal(writes.length, beforeReconnect);
        await editor.press("Enter");
        await page.getByText(/Sending again will resend/u).waitFor();
        for (const mode of [insertMode, sendMode]) {
          await mode.click();
          await editor.press("Enter");
          await page.getByText(/Sending again will resend/u).waitFor();
          assert.equal(
            writes.length,
            beforeReconnect,
            "switching modes must re-arm retry confirmation",
          );
        }
        assert.equal(
          writes.length,
          beforeReconnect,
          "uncertain input requires explicit confirmation",
        );
        if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
          mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `terminal-${profile.name}.png`),
          });
        }
        // Interrupting a pending insert-and-enter must cancel its trailing Enter.
        const beforeInterrupt = writes.length;
        holdNextWrite = true;
        await enterAction.click();
        const holdDeadline = Date.now() + 5_000;
        while (held.length === 0) {
          if (Date.now() > holdDeadline) throw new Error("No input acknowledgement to hold");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          await strip.getByRole("button", { name: "Ctrl+D", exact: true }).isDisabled(),
          true,
        );
        await page.getByRole("button", { name: "Ctrl+C", exact: true }).click();
        await page.getByText(/Acknowledgement was not received/u).waitFor();
        releaseHeld();
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLTextAreaElement>("[data-terminal-composer] textarea")
              ?.readOnly,
        );
        assert.deepEqual(writes.slice(beforeInterrupt), [uncertain, "\x03"]);
        assert.equal(await editor.inputValue(), uncertain);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  },
);
