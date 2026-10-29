import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererSidebarAgentIcons } from "./packages/renderer-extension/src/renderer-sidebar-agent-icons.ts";
      window.setupIcons = () => {
        const aside = document.querySelector("aside"), calls = [], owners = new Map();
        let holdOwnership = false, releaseOwnership;
        const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M2 2h10v10H2z"/></svg>');
        const add = (id, thread, agent, kind = "heartbeat") => {
          const wrap = document.createElement("div");
          const row = document.createElement("div");
          row.dataset.fixture = id;
          row.setAttribute("role", "button"); row.tabIndex = 0;
          row.setAttribute("data-sidebar-cycle-item", "");
          row.setAttribute("aria-labelledby", id + "-title");
          row.innerHTML = '<div class="body"><div class="title-line"><span data-thread-title id="' + id + '-title">Scheduled task ' + id + '</span></div><div class="time">Tomorrow · Daily</div></div><button type="button">Actions</button>';
          const automation = { id, kind, targetThreadId: thread };
          const owner = { memoizedProps: kind === "cloud" ? { item: { automation } } : { automation } };
          row.__reactFiber$fixture = { memoizedProps: {}, return: { memoizedProps: { "data-selected-scheduled-task": undefined }, return: owner } };
          owners.set(thread, agent);
          wrap.append(row); aside.append(wrap);
          return { row, owner };
        };
        const pi = add("pi", "pi-thread", "pi");
        add("claude", "claude-thread", "claude-code");
        add("codex", "codex-thread", "codex");
        add("cloud", "cloud-thread", "codex", "cloud");
        add("cron", "cron-thread", "codex", "cron");
        const regular = document.createElement("div");
        const attributes = { "data-app-action-sidebar-thread-row": "", "data-app-action-sidebar-thread-host-id": "local", "data-app-action-sidebar-thread-id": "local:codex-thread" };
        for (const [key,value] of Object.entries(attributes)) regular.setAttribute(key,value);
        regular.dataset.fixture = "regular";
        regular.innerHTML = '<div data-thread-title-trigger class="title-line"><span data-thread-title>Ordinary Codex chat</span></div>';
        regular.__reactFiber$fixture = { memoizedProps: { conversationId: "codex-thread", dataAttributes: attributes } };
        aside.append(regular);
        const control = installRendererSidebarAgentIcons({
          getClient: () => ({ listThreadOwnership: async ({ threadIds }) => {
            calls.push(threadIds);
            if (holdOwnership) await new Promise((resolve, reject) => { releaseOwnership = fail => fail ? reject(Error("Disconnected")) : resolve(); });
            if (threadIds.includes("unresolved-thread")) throw Error("Ownership unavailable");
            return { threads: threadIds.map(threadId => owners.get(threadId) === "codex"
              ? { threadId, owner: "codex" } : { threadId, owner: "external", harnessId: owners.get(threadId) }) };
          } }),
          getPlugins: () => [{ id: "pi", name: "Pi", icon }, { id: "claude-code", name: "Claude Code", icon }],
        });
        window.iconFixture = { calls, control,
          hold: () => { holdOwnership = true; },
          release: fail => { holdOwnership = false; releaseOwnership?.(fail); },
          replaceTitle: () => { const title = pi.row.querySelector('[data-thread-title]'); title.replaceWith(title.cloneNode(true)); },
          recycle: () => { pi.owner.memoizedProps = { automation: { id: "replacement", kind: "heartbeat", targetThreadId: "claude-thread" } }; pi.row.setAttribute("aria-labelledby", "pi-title"); },
          unsupported: () => { pi.owner.memoizedProps = { item: { automation: {} } }; pi.row.setAttribute("aria-labelledby", "pi-title"); },
          measureScheduledReads: () => {
            const key = "__reactFiber$fixture", fiber = pi.row[key];
            let reads = 0;
            Object.defineProperty(pi.row, key, { configurable: true, enumerable: true, get: () => { reads++; return fiber; } });
            control.refresh();
            return new Promise(resolve => requestAnimationFrame(() => {
              Object.defineProperty(pi.row, key, { configurable: true, enumerable: true, writable: true, value: fiber });
              resolve(reads);
            }));
          },
          unresolved: () => add("unknown", "unresolved-thread", "codex"),
        };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Sidebar icon fixture bundle is missing");
async function setup(page: Page) {
  await page.setContent(`<!doctype html><style>
    body { font:14px system-ui; background:Canvas; color:CanvasText; }
    aside { width:280px; } [data-fixture] { display:flex; gap:8px; align-items:center; padding:8px; border-radius:8px; }
    .body { min-width:0; flex:1; } .title-line { display:flex; align-items:center; gap:6px; min-width:0; }
    [data-thread-title] { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .time { opacity:.6; } button { flex:none; }
  </style><aside></aside>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(window, "setupIcons")());
}
const icons = (page: Page, row: string) =>
  page.locator(`[data-fixture="${row}"] [data-codexhost-sidebar-agent-icon]`);
async function act(page: Page, method: string) {
  return page.evaluate((method) => Reflect.get(window, "iconFixture")[method](), method);
}

for (const theme of ["light", "dark"] as const) {
  test(`renders actual ownership beside schedule titles and ordinary Codex chats in ${theme}`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await setup(page);
    await page.evaluate((theme) => (document.documentElement.style.colorScheme = theme), theme);
    for (const [row, agent] of [
      ["pi", "pi"],
      ["claude", "claude-code"],
      ["codex", "codex"],
      ["regular", "codex"],
    ] as const) {
      await expect(icons(page, row)).toHaveAttribute("data-codexhost-sidebar-agent-icon", agent);
      await expect(icons(page, row).locator("img,svg")).toHaveCount(1);
    }
    await expect(icons(page, "cloud")).toHaveCount(0);
    await expect(icons(page, "cron")).toHaveCount(0);
    const requests = await page.evaluate(() => Reflect.get(window, "iconFixture").calls.flat());
    expect(requests).not.toContain("cloud-thread");
    expect(requests).not.toContain("cron-thread");
    const aligned = await icons(page, "pi").evaluate((el) => {
      if (!el.nextElementSibling) throw new Error("Title anchor is missing");
      const title = el.nextElementSibling.getBoundingClientRect(),
        icon = el.getBoundingClientRect();
      return (
        icon.right <= title.left &&
        Math.abs(icon.y + icon.height / 2 - (title.y + title.height / 2)) < 2
      );
    });
    expect(aligned).toBe(true);
    await page.screenshot({ path: info.outputPath(`schedule-icons-${theme}.png`) });
  });
}

test("repairs title replacement, rebinds recycled rows and cleans up on disposal", async ({
  page,
}) => {
  await setup(page);
  await expect(icons(page, "pi")).toHaveCount(1);
  await act(page, "replaceTitle");
  await expect(icons(page, "pi")).toHaveCount(1);
  await act(page, "recycle");
  await expect(icons(page, "pi")).toHaveAttribute(
    "data-codexhost-sidebar-agent-icon",
    "claude-code",
  );
  await act(page, "unsupported");
  await expect(icons(page, "pi")).toHaveCount(0);
  await page.evaluate(() => Reflect.get(window, "iconFixture").control.dispose());
  await expect(page.locator("[data-codexhost-sidebar-agent-icon]")).toHaveCount(0);
});

for (const fail of [false, true]) {
  test(`keeps the same Codex icon nodes during repeated refresh and ${fail ? "failed" : "successful"} revalidation`, async ({
    page,
  }) => {
    await setup(page);
    await expect(icons(page, "regular")).toHaveAttribute(
      "data-codexhost-sidebar-agent-icon",
      "codex",
    );
    await expect(icons(page, "codex")).toHaveAttribute(
      "data-codexhost-sidebar-agent-icon",
      "codex",
    );
    const baseline = await page.evaluate(() => {
      const fixture = Reflect.get(window, "iconFixture");
      const nodes = [...document.querySelectorAll('[data-codexhost-sidebar-agent-icon="codex"]')];
      let removals = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const removed of record.removedNodes)
            if (nodes.some((icon) => removed === icon || removed.contains(icon))) removals++;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      fixture.iconState = () => ({ connected: nodes.every((node) => node.isConnected), removals });
      fixture.hold();
      const count = fixture.calls.length;
      fixture.control.refresh();
      fixture.control.refresh();
      return count;
    });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "iconFixture").calls.length))
      .toBeGreaterThan(baseline);
    expect(await act(page, "iconState")).toEqual({ connected: true, removals: 0 });
    await page.evaluate((fail) => Reflect.get(window, "iconFixture").release(fail), fail);
    // Let the reply and its scheduled DOM reconciliation finish.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await act(page, "iconState")).toEqual({ connected: true, removals: 0 });
  });
}

test("reads each native schedule once per scan and rechecks recycled targets", async ({ page }) => {
  await setup(page);
  await expect(icons(page, "pi")).toHaveAttribute("data-codexhost-sidebar-agent-icon", "pi");
  expect(await act(page, "measureScheduledReads")).toBe(1);
  await act(page, "recycle");
  await expect(icons(page, "pi")).toHaveAttribute(
    "data-codexhost-sidebar-agent-icon",
    "claude-code",
  );
  expect(await act(page, "measureScheduledReads")).toBe(1);
  await act(page, "unsupported");
  await expect(icons(page, "pi")).toHaveCount(0);
  expect(await act(page, "measureScheduledReads")).toBe(1);
});

test("does not label unknown ownership as Codex", async ({ page }) => {
  await setup(page);
  await expect(icons(page, "pi")).toHaveCount(1);
  await act(page, "unresolved");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Reflect.get(window, "iconFixture").calls.flat().includes("unresolved-thread"),
      ),
    )
    .toBe(true);
  await expect(icons(page, "unknown")).toHaveCount(0);
});
