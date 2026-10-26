import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "./ch-host.ts";
import { withDiscovery } from "./harness-commands.ts";
import { startServer } from "./server.ts";

export async function discoveryBrowser(t: TestContext, width = 1280, agents = false) {
  const host = new FakeChHost();
  host.add("existing", "/computer/project", "Discovery source");
  host.add("destination", "/computer/project", "Discovery destination");
  const state = withDiscovery(host);
  state.extraHarnesses = agents;
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    ["--ch-cdp", debug.endpoint],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    isMobile: width < 600,
    hasTouch: width < 600,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(url);
  const plus = page.getByRole("button", { name: "Add files or run commands", exact: true });
  const menu = page.getByRole("listbox", { name: "Trigger suggestions", exact: true });
  const composer = page.locator("[data-composer-input]:visible");
  await plus.waitFor();
  const open = async (id = "existing") => {
    await page.keyboard.press("Escape");
    const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true }).last();
    if (await sidebar.isVisible()) await sidebar.click();
    const folder = page.getByRole("treeitem").filter({ hasText: /^project$/u });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator(`[data-row-key="session:${id}"]`).click();
    await page.locator(`[data-conversation-session="${id}"] [data-composer-input]`).waitFor();
    await page.getByText("existing CH answer", { exact: true }).waitFor();
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
  return { host, state, page, composer, plus, menu, open, attach, writeMethods };
}
