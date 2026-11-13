/** Fixture Host protocol only; the browser uses the production Web tree and placement endpoints. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { FakeChChannel, startFakeChChannel } from "./ch-channel.ts";
import { startFakeChDebugger } from "./ch-host.ts";
import { startServer } from "./server.ts";

export class ThreadTreeBrowserHost extends FakeChChannel {
  readonly delegations: Record<string, string> = {
    child: "parent",
    grandchild: "child",
    deep: "grandchild",
    deepest: "deep",
    target: "target-root",
  };
  readonly placements = new Map<string, string | null>();
  placeError: string | undefined;
  readonly archiveFailures = new Set<string>();
  get parents(): Record<string, string> {
    const parents = new Map(Object.entries(this.delegations));
    for (const [id, parent] of this.placements) {
      if (parent === null) parents.delete(id);
      else parents.set(id, parent);
    }
    return Object.fromEntries(parents);
  }
  override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "codexhost/thread/tree/read" || method === "codexhost/thread/tree/place") {
      this.requests.push({ method, params: structuredClone(params) });
      if (method.endsWith("/place")) {
        if (this.placeError) throw new Error(this.placeError);
        this.placements.set(
          String(params.threadId),
          params.parentThreadId === null ? null : String(params.parentThreadId),
        );
        this.changed(String(params.threadId), "codexhost/thread/tree/changed");
      }
      return { parents: this.parents } as T;
    }
    if (method === "thread/archive" && this.archiveFailures.has(String(params.threadId))) {
      this.requests.push({ method, params: structuredClone(params) });
      throw new Error("Child archive write refused");
    }
    return super.request<T>(method, params);
  }
}

export async function threadTreeBrowser(t: TestContext, width = 1280, selected?: string) {
  const directory = mkdtempSync(join(tmpdir(), "thread-tree-browser-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = new ThreadTreeBrowserHost();
  for (const [id, title] of Object.entries({
    parent: "Release plan",
    child: "Delegated implementation",
    grandchild: "Approval checks",
    deep: "Deep review",
    deepest: "Nested follow-up",
    "target-root": "Design plan",
    target: "Move target",
    destination: "Destination chat",
    archived: "Archived work",
  }))
    host.add(id, "/computer/thread-tree", title, false);
  const native = host.add("native", "/computer/thread-tree", "Native worker", false);
  native.parentThreadId = "parent";
  native.canAcceptDirectInput = false;
  host.archivedIds.add("archived");
  const now = Math.floor(Date.now() / 1000);
  for (const row of host.threads.values()) {
    row.createdAt = now - 7200;
    row.updatedAt = now - 300;
  }
  // A shared pin on a child must remain untouched and must not create a Web pinned section.
  host.pinnedIds = ["child"];
  const running = host.threads.get("grandchild");
  assert.ok(running);
  running.status = { type: "active" };
  const channel = await startFakeChChannel(host, directory);
  const debug = await startFakeChDebugger(host);
  t.after(() => channel.close());
  t.after(() => debug.close());
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    [
      "--session-source",
      "codexhost",
      "--ch-control-directory",
      directory,
      "--ch-cdp",
      debug.endpoint,
      "--adapters",
      "test/fake-harness",
    ],
  );
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    isMobile: width === 390,
    hasTouch: width === 390,
    locale: "en-US",
    // Geometry checks inspect settled rows rather than the phone drawer spring.
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const destination = new URL(url);
  if (selected) destination.searchParams.set("session", selected);
  await page.goto(destination.href);
  await page.getByText("Native Model", { exact: true }).waitFor();
  if (selected)
    await page.locator(`[data-conversation-session="${selected}"] [data-composer-input]`).waitFor();
  await openSidebar(page);
  return { host, page, url };
}

export async function openSidebar(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: "Open sidebar", exact: true }).first();
  if (await open.isVisible()) await open.click();
}

export function threadRow(page: Page, id: string) {
  return page.locator(`[data-row-key="recent:${id}"], [data-row-key="session:${id}"]`).first();
}

export async function viewOption(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "View options", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

export async function threadMenu(page: Page, id: string): Promise<void> {
  const row = threadRow(page, id);
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await row.getByRole("button", { name: /^Session actions for / }).click();
  } else {
    await row.focus();
    await row.press("Shift+F10");
  }
}

export async function treeShot(page: Page, name: string): Promise<void> {
  if (!process.env.CODEXHOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
  await page.waitForFunction(() => {
    const drawer = document.querySelector("[data-phone-drawer][data-open]");
    return drawer === null || Math.abs(drawer.getBoundingClientRect().left) < 0.25;
  });
  await page.screenshot({
    path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `${name}.png`),
    animations: "disabled",
  });
}
