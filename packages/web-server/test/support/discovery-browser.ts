import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FakeChChannel, startFakeChChannel } from "./ch-channel.ts";
import type { TestContext } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "./ch-host.ts";
import { withDiscovery } from "./harness-commands.ts";
import { startServer } from "./server.ts";
import { composerMenu } from "./composer-menu.ts";

export async function discoveryBrowser(
  t: TestContext,
  width = 1280,
  agents = false,
  realtime = false,
) {
  // Close pages before their server, so reconnect checks do not race test teardown.
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const host = realtime ? new FakeChChannel() : new FakeChHost();
  host.add("existing", "/computer/project", "Discovery source");
  host.add("destination", "/computer/project", "Discovery destination");
  const state = withDiscovery(host);
  state.extraHarnesses = agents;
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const channelArgs: string[] = [];
  if (host instanceof FakeChChannel) {
    const directory = await mkdtemp(join(tmpdir(), "discovery-channel-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    channelArgs.push("--ch-control-directory", directory);
  }
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    ["--ch-cdp", debug.endpoint, ...channelArgs],
    { authenticated: true },
  );
  const page = await browser.newPage({
    locale: "en-US",
    viewport: { width, height: 900 },
    isMobile: width < 600,
    hasTouch: width < 600,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`);
  });
  await page.goto(url);
  const menu = page.getByRole("listbox", { name: "Trigger suggestions", exact: true });
  const composer = page.locator("[data-composer-input]:visible");
  await composer.waitFor();
  const closeMobileSidebar = async () => {
    if (width >= 600) return;
    const frame = page.locator("[data-phone]");
    if ((await frame.getAttribute("data-sidebar-collapsed")) === null)
      await page.getByRole("button", { name: "Collapse sidebar", exact: true }).first().click();
    await page.locator("[data-phone][data-sidebar-collapsed]").waitFor();
    await page.waitForFunction(() => {
      const drawer = document.querySelector("[data-phone-drawer]");
      return drawer === null || drawer.getBoundingClientRect().right <= 0;
    });
  };
  await closeMobileSidebar();
  const openCommands = composerMenu(composer);
  const openReferences = composerMenu(composer, "@");
  const open = async (id = "existing") => {
    await page.keyboard.press("Escape");
    const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true }).last();
    if (await sidebar.isVisible()) await sidebar.click();
    const folder = page
      .locator('[data-row-key^="workspace:"]')
      .filter({ hasText: /^\/computer\/project$/u });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator(`[data-row-key="session:${id}"]`).click();
    await page.locator(`[data-conversation-session="${id}"] [data-composer-input]`).waitFor();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
    await closeMobileSidebar();
  };
  const attach = async () => {
    await page.locator('input[type="file"]').setInputFiles({
      name: "kept.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("kept attachment"),
    });
    await page
      .getByRole("group", { name: "Pending attachments", exact: true })
      .getByText("kept.txt", { exact: true })
      .waitFor();
  };
  const writeMethods = () =>
    host.requests.filter((r) =>
      [
        "turn/start",
        "turn/steer",
        "thread/start",
        "thread/resume",
        "codexhost/thread/command/execute",
        "codexhost/thread/model/select",
      ].includes(r.method),
    );
  t.after(() => assert.deepEqual(errors, []));
  return {
    host,
    state,
    page,
    composer,
    openCommands,
    openReferences,
    menu,
    open,
    attach,
    writeMethods,
  };
}
