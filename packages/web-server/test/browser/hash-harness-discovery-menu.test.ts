import assert from "node:assert/strict";
import { it } from "node:test";
import { restoreHarnessCommandMentions } from "@codexhost/shared-contracts";
import { defined } from "../support/defined.ts";
import { discoveryBrowser } from "../support/discovery-browser.ts";

for (const [trigger, width] of [
  ["#", 390],
  ["#", 1280],
  ["@", 390],
  ["@", 1280],
] as const)
  it(
    `${trigger} alias shares native menu, carriers and direct execution at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { host, page, composer, plus, menu, open, attach, writeMethods } =
        await discoveryBrowser(t, width, true);
      const reads = () =>
        host.requests.filter((r) => r.method === "codexhost/thread/commands/inspect");
      await composer.fill(trigger);
      await menu.getByRole("option", { name: "Codex codex-cli", exact: true }).waitFor();
      assert.equal(await menu.locator('[id*="codexhost-native"]').count(), 0);
      assert.equal(
        reads().length,
        0,
        "draft delegation does not inspect native commands or prewarm",
      );
      assert.equal(writeMethods().length, 0);
      await page.keyboard.press("Escape");
      await plus.click();
      await menu.getByRole("option", { name: /^Model\b/ }).waitFor();
      await open();
      await composer.fill(trigger);
      await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
      await menu.getByRole("option", { name: "Codex codex-cli", exact: true }).waitFor();
      assert.equal(
        await menu.getByRole("option", { name: /^Model\b|^Permission\b|^File\b/ }).count(),
        0,
      );
      const native = menu.locator('[id*="codexhost-native"]');
      const rows = await native.allTextContents();
      const beforeSearch = reads().length;
      await composer.press("n");
      await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
      await composer.press("a");
      await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
      assert.equal(reads().length, beforeSearch, "alias filtering shares one opening's read");
      await page.keyboard.press("Escape");
      assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
      await composer.fill("/");
      await menu.getByRole("option", { name: /^Native skill\b/ }).waitFor();
      assert.deepEqual(
        await native.allTextContents(),
        rows,
        "slash and its aliases use the same native rows",
      );
      assert.equal(
        reads().length,
        beforeSearch + 1,
        "one refresh per opening, no alias duplicate source",
      );
      await page.keyboard.press("Escape");
      await composer.fill(`before ${trigger}native-skill after`);
      await composer.press("Home");
      for (let i = 0; i < `before ${trigger}native-skill`.length; i++)
        await composer.press("ArrowRight");
      await menu.getByRole("option", { name: /^Native skill\b/ }).click();
      await composer.locator('[data-composer-chip="codexhost-native"]').waitFor();
      assert.ok((await composer.innerText()).includes("before"));
      assert.ok((await composer.innerText()).includes("after"));
      assert.equal((await composer.innerText()).includes(`${trigger}native-skill`), false);
      await attach();
      await composer.press("End");
      await composer.press(" ");
      await composer.pressSequentially(`${trigger}codex-cli`);
      await menu.getByRole("option", { name: "Codex codex-cli", exact: true }).waitFor();
      await composer.press("Enter");
      const agent = composer.locator('[data-composer-chip="codexhost-delegation"]');
      const icon = agent.locator('img[src="/harness-icons/codex-cli"]');
      await icon.waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>(
          '[data-composer-chip="codexhost-delegation"] img',
        );
        return image?.complete && image.naturalWidth > 0;
      });
      assert.equal(await agent.innerText(), "Codex");
      assert.equal(writeMethods().length, 0);
      await composer.press("ControlOrMeta+A");
      await composer.press("ControlOrMeta+C");
      const text = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(text.includes("subagent://codexhost-command.native-skill"));
      assert.ok(text.includes("subagent://codexhost.codex-cli"));
      assert.equal(text.includes(`${trigger}codex-cli`), false);
      const submitted = page.waitForResponse((response) =>
        response.url().endsWith("/api/session/prompt"),
      );
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await submitted;
      await page
        .getByRole("group", { name: "Pending attachments", exact: true })
        .waitFor({ state: "hidden" });
      const sent = defined(host.requests.find((r) => r.method === "turn/start"));
      const restored = restoreHarnessCommandMentions(
        (sent.params.input as Array<{ text: string }>).map((part) => part.text).join("\n"),
      );
      assert.match(restored, /^\/native-skill /);
      assert.ok(restored.includes("kept.txt:"));
      assert.ok(restored.includes("before"));
      assert.ok(restored.includes("after"));
      assert.ok(restored.includes("subagent://codexhost.codex-cli"));
      await composer.fill(`body ${trigger}compact`);
      await attach();
      await menu.getByRole("option", { name: /^Compact\b/ }).waitFor();
      const executed = page.waitForResponse((response) =>
        response.url().endsWith("/api/codexhost/executeThreadCommand"),
      );
      await composer.press("Enter");
      assert.equal((await executed).status(), 200);
      assert.equal(await composer.innerText(), "body ");
      await page
        .getByRole("group", { name: "Pending attachments", exact: true })
        .getByText("kept.txt", { exact: true })
        .waitFor();
      assert.equal(host.requests.filter((r) => r.method === "turn/start").length, 1);
      const direct = defined(
        host.requests.find((r) => r.method === "codexhost/thread/command/execute"),
      );
      assert.deepEqual(structuredClone(direct.params), {
        threadId: "existing",
        commandId: "fake.compact",
      });
      await plus.click();
      await menu.getByRole("option", { name: /^Compact\b/, disabled: false }).waitFor();
      assert.equal(
        await page
          .getByText("Command accepted. Follow progress in this Thread.", { exact: true })
          .count(),
        0,
        "aliases must not leave an acceptance banner either",
      );
    },
  );

it(
  "delegation Harness icons survive undo and persisted draft restoration",
  { timeout: 60_000 },
  async (t) => {
    const { page, composer, menu, open, writeMethods } = await discoveryBrowser(t, 1280, true);
    await open();
    await composer.fill("delegate #codex-cli");
    await menu.getByRole("option", { name: "Codex codex-cli", exact: true }).click();
    const chip = composer.locator('[data-composer-chip="codexhost-delegation"]');
    const icon = chip.locator('img[src="/harness-icons/codex-cli"]');
    await icon.waitFor();
    await composer.press("ControlOrMeta+Z");
    assert.equal(await chip.count(), 0);
    await composer.press("ControlOrMeta+Shift+Z");
    await icon.waitFor();
    await composer.press("ControlOrMeta+A");
    await composer.press("ControlOrMeta+C");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(text.trim(), "delegate [@Codex](subagent://codexhost.codex-cli)");
    await page.reload();
    await icon.waitFor();
    assert.equal(await chip.innerText(), "Codex");
    await composer.click();
    await composer.press("ControlOrMeta+A");
    await composer.press("ControlOrMeta+C");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    assert.equal(writeMethods().length, 0);
  },
);

it(
  "hash boundary negatives, Markdown space and IME do not consume or send input",
  { timeout: 60_000 },
  async (t) => {
    const { host, page, composer, menu, open, writeMethods } = await discoveryBrowser(t);
    await open();
    for (const text of [
      "#123",
      "##",
      "###native",
      "\\#native",
      "word#native",
      "https://host/#native",
      "https://host/#/compact",
      "# ",
      "# heading",
    ]) {
      const count = host.requests.filter(
        (r) => r.method === "codexhost/thread/commands/inspect",
      ).length;
      await composer.fill(text);
      await page.waitForTimeout(30);
      assert.equal(await menu.count(), 0, text);
      assert.equal(await composer.innerText(), text);
      assert.equal(
        host.requests.filter((r) => r.method === "codexhost/thread/commands/inspect").length,
        count,
      );
    }
    await composer.fill("#");
    await menu.getByRole("option", { name: /^Compact\b/ }).waitFor();
    await composer.press(" ");
    await menu.waitFor({ state: "hidden" });
    await composer.pressSequentially("heading");
    assert.equal(await composer.innerText(), "# heading");
    await composer.fill("#native-info");
    await menu.getByRole("option", { name: /^Native info\b/ }).waitFor();
    await composer.dispatchEvent("compositionstart", { data: "" });
    await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    assert.equal(writeMethods().length, 0);
    await composer.dispatchEvent("compositionend", { data: "" });
    await page.waitForTimeout(20);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    assert.equal(await composer.innerText(), "#native-info");
    assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
  },
);

it(
  "hash errors, stale sessions and busy states use the shared source",
  { timeout: 60_000 },
  async (t) => {
    const { host, state, page, composer, menu, open, writeMethods } = await discoveryBrowser(
      t,
      1280,
      true,
    );
    await open();
    state.failure = "Hash fixture catalog failure";
    await composer.fill("#");
    await menu.getByRole("option", { name: /Retry native commands/ }).waitFor();
    await menu.getByRole("option", { name: "Codex codex-cli", exact: true }).waitFor();
    state.failure = "";
    await menu.getByRole("option", { name: /Retry native commands/ }).click();
    await menu.getByRole("option", { name: /^Compact\b/ }).waitFor();
    await page.keyboard.press("Escape");
    const gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    state.beforeInspect = async () => {
      await gate.promise;
    };
    await composer.fill("reopen");
    await composer.fill("#");
    await menu.locator('[role="status"]').waitFor();
    defined(state.catalog.commands[0]).label = "Destination compact";
    await open("destination");
    state.beforeInspect = async () => {};
    await composer.fill("#");
    await menu.getByRole("option", { name: /^Destination compact\b/ }).waitFor();
    gate.resolve(undefined);
    await page.waitForTimeout(50);
    assert.equal(await menu.getByRole("option", { name: /^Compact\b/ }).count(), 0);
    assert.ok(
      host.requests.some(
        (r) =>
          r.method === "codexhost/thread/commands/inspect" && r.params.threadId === "destination",
      ),
    );
    defined(host.threads.get("destination")).status.type = "active";
    await page.reload();
    await open("destination");
    await composer.fill("#compact");
    const compact = menu.getByRole("option", { name: /^Destination compact\b/ });
    await compact.waitFor();
    assert.equal(await compact.getAttribute("aria-disabled"), "true");
    await compact.click({ force: true });
    assert.equal(await composer.innerText(), "#compact");
    assert.equal(writeMethods().length, 0);
  },
);

it(
  "hash reconnect invalidates the pending catalog without changing execution or cache engines",
  { timeout: 60_000 },
  async (t) => {
    const { state, page, composer, menu, open, writeMethods } = await discoveryBrowser(t);
    let disconnect: (() => void) | undefined;
    await page.routeWebSocket("**/api/remote.mux", (socket) => {
      socket.connectToServer();
      disconnect = () => {
        socket.close({ code: 1012, reason: "fixture reconnect" });
      };
    });
    await page.reload();
    await open();
    const gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    let waiting = false;
    state.beforeInspect = async () => {
      waiting = true;
      await gate.promise;
    };
    await composer.fill("#");
    await menu.locator('[role="status"]').waitFor();
    for (let i = 0; !waiting && i < 100; i++) await page.waitForTimeout(10);
    assert.equal(waiting, true);
    state.beforeInspect = async () => {};
    defined(state.catalog.commands[0]).label = "Reconnected compact";
    assert.ok(disconnect);
    const reconnected = page.waitForResponse((response) =>
      response.url().endsWith("/api/session/modelCatalog"),
    );
    disconnect();
    await reconnected;
    await composer.fill("reopen");
    await composer.fill("#");
    await menu.getByRole("option", { name: /^Reconnected compact\b/ }).waitFor();
    gate.resolve(undefined);
    await page.waitForTimeout(50);
    assert.equal(await menu.getByRole("option", { name: /^Compact\b/ }).count(), 0);
    assert.equal(writeMethods().length, 0);
  },
);
