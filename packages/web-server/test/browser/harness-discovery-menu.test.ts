import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { restoreHarnessCommandMentions } from "@codexhost/shared-contracts";
import { defined } from "../support/defined.ts";
import { discoveryBrowser } from "../support/discovery-browser.ts";

for (const width of [390, 1280])
  it(`native discovery and direct/text selection at ${width}px`, { timeout: 60_000 }, async (t) => {
    const { host, state, page, composer, plus, menu, open, attach, writeMethods } =
      await discoveryBrowser(t, width);
    await plus.click();
    await menu.getByRole("option", { name: /^Model\b/ }).waitFor();
    assert.equal(await menu.getByText("Native commands", { exact: true }).count(), 0);
    assert.equal(await menu.getByText("Delegation Agents", { exact: true }).count(), 0);
    assert.equal(
      host.requests.some((r) => r.method === "codexhost/thread/commands/inspect"),
      false,
    );
    await open();
    await composer.fill("keep body");
    await attach();
    const uploadsBefore = host.requests.filter((r) => r.method === "turn/start").length;
    await plus.click();
    const compact = menu.getByRole("option", { name: /^Compact\b/ });
    await compact.waitFor();
    assert.equal(
      await menu.getByRole("option", { name: /^Native model\b/ }).getAttribute("aria-disabled"),
      "true",
    );
    assert.ok((await menu.innerText()).includes("Invocation conflicts"));
    assert.ok((await menu.innerText()).includes("Skills"));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `harness-discovery-${width}.png`),
        animations: "disabled",
      });
    }
    const count = host.requests.filter(
      (r) => r.method === "codexhost/thread/commands/inspect",
    ).length;
    await page.keyboard.press("Escape");
    await composer.fill("/nat");
    await menu.getByRole("option", { name: /^Native info\b/ }).waitFor();
    const opened = host.requests.filter(
      (r) => r.method === "codexhost/thread/commands/inspect",
    ).length;
    await composer.press("i");
    await composer.press("Backspace");
    await menu.getByRole("option", { name: /^Native info\b/ }).waitFor();
    assert.equal(
      host.requests.filter((r) => r.method === "codexhost/thread/commands/inspect").length,
      opened,
      "search stays local",
    );
    assert.ok(opened > count);
    await page.keyboard.press("Escape");
    await composer.fill("keep body");
    await plus.click();
    await compact.click();
    await page
      .getByText("Command accepted. Follow progress in this Thread.", { exact: true })
      .waitFor();
    assert.equal(await composer.innerText(), "keep body");
    await page.getByText("kept.txt", { exact: true }).waitFor();
    assert.equal(host.requests.filter((r) => r.method === "turn/start").length, uploadsBefore);
    assert.deepEqual(structuredClone(writeMethods().map((r) => [r.method, r.params])), [
      ["codexhost/thread/command/execute", { threadId: "existing", commandId: "fake.compact" }],
    ]);
    await plus.click();
    await menu.getByRole("option", { name: /^Native skill\b/ }).click();
    await composer
      .locator('[data-composer-chip="codexhost-native"]')
      .getByText("/native-skill", { exact: true })
      .waitFor();
    assert.ok((await composer.innerText()).includes("keep body"));
    assert.equal(writeMethods().length, 1);
    await composer.press("ControlOrMeta+Z");
    assert.equal(await composer.innerText(), "keep body", "selection is undoable");
    await plus.click();
    await menu.getByRole("option", { name: /^Native skill\b/ }).click();
    await composer.press("Escape");
    const submitted = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/prompt"),
    );
    await composer.press("Enter");
    await submitted;
    await page.waitForFunction(
      () => document.querySelector("[data-composer-input]:not([hidden])")?.textContent === "",
    );
    const sent = host.requests.filter((r) => r.method === "turn/start").at(-1);
    assert.ok(sent);
    assert.match(JSON.stringify(sent.params.input), /subagent:\/\/codexhost-command\.native-skill/);
    assert.match(JSON.stringify(sent.params.input), /kept\.txt/);
    const nativeText = restoreHarnessCommandMentions(
      (sent.params.input as Array<{ text: string }>).map((part) => part.text).join("\n"),
    );
    assert.match(
      nativeText,
      /^\/native-skill /u,
      "prepared attachment context must not hide the invocation",
    );
    // Manual compact arguments follow ordinary message submission, never the menu shortcut.
    await composer.fill("/compact  preserve\targuments");
    await composer.press("Escape");
    const manual = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/prompt"),
    );
    await composer.press("Enter");
    await manual;
    assert.match(
      JSON.stringify(host.requests.filter((r) => r.method === "turn/start").at(-1)?.params.input),
      /compact  preserve\\targuments/,
    );
    assert.equal(
      host.requests.filter((r) => r.method === "codexhost/thread/command/execute").length,
      1,
    );
    state.catalog.source = "static";
    await plus.click();
    await menu.getByText(/Static catalog:/).waitFor();
  });

it(
  "errors retain interface rows, allow retry, and late catalogs cannot cross sessions or reopen a closed menu",
  { timeout: 60_000 },
  async (t) => {
    const { host, state, page, composer, plus, menu, open } = await discoveryBrowser(t);
    await open();
    state.failure = "Catalog failed";
    await plus.click();
    await menu.getByRole("option", { name: /Retry native commands/ }).waitFor();
    await menu.getByRole("option", { name: /^Model\b/ }).waitFor();
    state.failure = "";
    await menu.getByRole("option", { name: /Retry native commands/ }).click();
    await menu.getByRole("option", { name: /^Compact\b/ }).waitFor();
    await page.keyboard.press("Escape");
    const gate = Promise.withResolvers<undefined>();
    state.beforeInspect = async () => {
      await gate.promise;
    };
    await plus.click();
    await menu.locator('[role="status"]').waitFor();
    defined(state.catalog.commands[0]).label = "Destination compact";
    await open("destination");
    state.beforeInspect = async () => {};
    await plus.click();
    await menu.getByRole("option", { name: /^Destination compact\b/ }).waitFor();
    gate.resolve(undefined);
    await page.waitForTimeout(100);
    assert.equal(await menu.getByRole("option", { name: /^Compact\b/ }).count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await menu.count(), 0);
    assert.equal(await composer.evaluate((el) => el === document.activeElement), true);
    assert.equal(
      host.requests.some((r) => ["thread/start", "turn/start", "thread/resume"].includes(r.method)),
      false,
    );
  },
);

it(
  "busy, duplicate and unknown direct writes preserve the draft and are not retried",
  { timeout: 60_000 },
  async (t) => {
    const { host, state, page, composer, plus, menu, open } = await discoveryBrowser(t);
    await open();
    await composer.fill("body survives");
    const gate = Promise.withResolvers<undefined>();
    state.beforeExecute = async () => {
      await gate.promise;
    };
    await plus.click();
    await menu.getByRole("option", { name: /^Bare skill\b/ }).click();
    await plus.click();
    await menu.getByRole("option", { name: /^Compact\b/ }).waitFor();
    assert.equal(
      await menu.getByRole("option", { name: /^Compact\b/ }).getAttribute("aria-disabled"),
      "true",
    );
    state.executionFailure = "Connection lost; outcome unknown";
    gate.resolve(undefined);
    await page.getByText(/Command not confirmed.*Connection lost/).waitFor();
    assert.equal(await composer.innerText(), "body survives");
    assert.equal(
      host.requests.filter((r) => r.method === "codexhost/thread/command/execute").length,
      1,
    );
  },
);

it(
  "an active Thread disables direct commands while keeping text selections available",
  { timeout: 60_000 },
  async (t) => {
    const { host, page, composer, plus, menu, open, writeMethods } = await discoveryBrowser(t);
    defined(host.threads.get("existing")).status.type = "active";
    await page.reload();
    await plus.waitFor();
    await open();
    await composer.fill("retained busy draft");
    await plus.click();
    const compact = menu.getByRole("option", { name: /^Compact\b/ });
    await compact.waitFor();
    assert.equal(await compact.getAttribute("aria-disabled"), "true");
    await compact.click({ force: true });
    assert.equal(await menu.count(), 1, "disabled selection explains itself and stays open");
    assert.equal(writeMethods().length, 0);
    await menu.getByRole("option", { name: /^Native skill\b/ }).click();
    await composer.locator('[data-composer-chip="codexhost-native"]').waitFor();
    assert.ok((await composer.innerText()).includes("retained busy draft"));
    assert.equal(writeMethods().length, 0);
  },
);

it(
  "offline projection disables direct writes and browser reconnect fences an old menu read",
  { timeout: 60_000 },
  async (t) => {
    const { host, state, page, composer, plus, menu, open, writeMethods } =
      await discoveryBrowser(t);
    let offline = true;
    await page.routeWebSocket("**/api/remote.mux", (socket) => {
      const server = socket.connectToServer();
      const controls = new Set<string>();
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "open" && frame.endpoint === "session/control")
          controls.add(frame.streamId);
        server.send(message);
      });
      server.onMessage((message) => {
        socket.send(message);
        const frame = JSON.parse(String(message));
        if (offline && controls.has(frame.streamId) && frame.value?.type === "baseline")
          socket.send(
            JSON.stringify({
              type: "item",
              streamId: frame.streamId,
              value: {
                type: "projection",
                sessionId: "existing",
                key: "nativeConnection",
                value: { state: "reconnecting" },
                seq: Number.MAX_SAFE_INTEGER,
              },
            }),
          );
      });
    });
    await page.reload();
    await plus.waitFor();
    await open();
    await composer.fill("offline draft");
    await plus.click();
    const compact = menu.getByRole("option", { name: /^Compact\b/ });
    await compact.waitFor();
    assert.equal(await compact.getAttribute("title"), "Host disconnected");
    assert.equal(writeMethods().length, 0);
    offline = false;
    await page.addInitScript(() => {
      const Original = window.WebSocket;
      const sockets: WebSocket[] = [];
      Object.assign(window, { discoveryTestSockets: sockets });
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      };
    });
    await page.reload();
    await plus.waitFor();
    await open();
    const gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    let blocked = false;
    state.beforeInspect = async () => {
      blocked = true;
      await gate.promise;
    };
    await plus.click();
    await menu.locator('[role="status"]').waitFor();
    while (!blocked) await page.waitForTimeout(10);
    defined(state.catalog.commands[0]).label = "After reconnect";
    state.beforeInspect = async () => {};
    await page.evaluate(() => {
      const sockets = (window as unknown as { discoveryTestSockets: WebSocket[] })
        .discoveryTestSockets;
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    });
    await menu.getByRole("option", { name: /^After reconnect\b/ }).waitFor();
    gate.resolve(undefined);
    await page.waitForTimeout(100);
    assert.equal(await menu.getByRole("option", { name: /^Compact\b/ }).count(), 0);
    assert.equal(writeMethods().length, 0);
    assert.equal(
      host.requests.some((r) => r.method === "codexhost/harness/commands/inspect"),
      false,
    );
  },
);

it(
  "command carriers survive undo, copy, draft restore and rejected/unknown sends with delegation and a file",
  { timeout: 60_000 },
  async (t) => {
    const { host, page, composer, plus, menu, open, attach, writeMethods } =
      await discoveryBrowser(t);
    await open();
    const body = "review  attached\tfile\n  keep indentation";
    await composer.fill(body);
    await attach();
    await plus.click();
    await menu.getByRole("option", { name: /^Native skill\b/ }).click();
    const commands = composer.locator('[data-composer-chip="codexhost-native"]');
    await commands.waitFor();
    await composer.press("ControlOrMeta+Z");
    assert.equal(await commands.count(), 0);
    assert.equal(await composer.innerText(), body);
    await page.getByText("kept.txt", { exact: true }).waitFor();
    await plus.click();
    await menu.getByRole("option", { name: /^Native skill\b/ }).click();
    await plus.click();
    await menu.getByRole("option", { name: "CH Harness fake", exact: true }).click();
    const agents = composer.locator('[data-composer-chip="codexhost-delegation"]');
    await agents.waitFor();
    await composer.press("ControlOrMeta+A");
    await composer.press("ControlOrMeta+C");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clipboard.includes("[@/native-skill](subagent://codexhost-command.native-skill)"));
    assert.ok(clipboard.includes("subagent://codexhost.fake"));
    assert.ok(restoreHarnessCommandMentions(clipboard).includes(body));
    assert.equal(writeMethods().length, 0);
    await composer.press("Backspace");
    assert.equal(await commands.count(), 0);
    await composer.press("ControlOrMeta+Z");
    await commands.waitFor();
    await agents.waitFor();
    await page.reload();
    await commands.waitFor();
    await agents.waitFor();
    await composer.click();
    await composer.press("ControlOrMeta+A");
    await composer.press("ControlOrMeta+C");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), clipboard);
    await attach();
    let attempts = 0;
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method !== "turn/start") return request<T>(method, params);
      attempts++;
      const prepared = (params.input as Array<{ text: string }>)
        .map((part) => part.text)
        .join("\n");
      const restored = restoreHarnessCommandMentions(prepared);
      assert.match(restored, /^\/native-skill /u);
      assert.ok(restored.includes(body));
      assert.ok(restored.includes("kept.txt:"));
      assert.ok(restored.includes("subagent://codexhost.fake"));
      if (attempts === 2) await request<T>(method, params);
      throw new Error(attempts === 1 ? "Skill refused" : "Skill result unknown");
    };
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText(/Skill refused/).waitFor();
    await commands.waitFor();
    await agents.waitFor();
    await page.getByText("kept.txt", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText(/Skill result unknown/).waitFor();
    await commands.waitFor();
    await agents.waitFor();
    await page.waitForTimeout(100);
    assert.equal(attempts, 2, "no automatic retry");
  },
);
