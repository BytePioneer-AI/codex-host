/** Cold-entry ordering checks: real browser + source Web gateway, synthetic Host, no model calls. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page, type Route } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

const FIRST = "progressive-first";
const SECOND = "progressive-second";
const ANSWER = "Synthetic progressive first answer";
const OTHER = "Synthetic progressive second answer";
const WAIT = 5_000;
const diagnosticPages = new WeakMap<Page, (stage: string) => Promise<void>>();

async function diagnose(page: Page, stage: string): Promise<void> {
  await diagnosticPages.get(page)?.(stage);
}

async function openFromSidebar(page: Page, id = FIRST): Promise<void> {
  const folder = page.getByRole("treeitem").filter({ hasText: /^progressive$/ });
  await folder.waitFor({ timeout: WAIT });
  if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
  await page.locator(`[data-row-key="session:${id}"]`).click({ timeout: WAIT });
}

it("unauthenticated direct entry cannot fetch or display chat", { timeout: 30_000 }, async (t) => {
  const { page, url } = await fixture(t, true);
  const target = new URL(direct(url));
  target.searchParams.delete("token");
  let apiRequests = 0;
  page.on("request", (request) => {
    if (/\/api\/session\//u.test(new URL(request.url()).pathname)) apiRequests++;
  });
  await page.goto(target.href);
  await page.locator("#form #token").waitFor({ timeout: WAIT });
  assert.equal(await page.getByText(ANSWER, { exact: true }).count(), 0);
  assert.equal(apiRequests, 0, "authentication is still a necessary gate");
});

it(
  "a late direct-ID summary cannot replace a newer sidebar selection",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    const gate = await holdRpc(page, "session/list", (route) => rpcArgs(route).sessionId === FIRST);
    const lookupCompleted = Promise.withResolvers<undefined>();
    page.on("response", (response) => {
      if (
        response.url().endsWith("/api/session/list") &&
        rpcArgsFromRequest(response.request().postDataJSON()).sessionId === FIRST
      )
        void response.finished().then(() => lookupCompleted.resolve(undefined));
    });
    try {
      await page.goto(direct(url));
      await gate.reached();
      const folder = page.getByRole("treeitem").filter({ hasText: /^progressive$/ });
      await folder.waitFor({ timeout: WAIT });
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator(`[data-row-key="session:${SECOND}"]`).click({ timeout: WAIT });
      await chat(page, OTHER);
      gate.pending();
    } finally {
      await gate.release();
    }
    // Wait for the delayed lookup to finish before checking the selected view.
    await bounded(lookupCompleted.promise);
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    const overwritten = await page.getByText(ANSWER, { exact: true }).isVisible();
    t.diagnostic(`late-summary: original-target-visible-after-new-selection=${overwritten}`);
    assert.equal(overwritten, false, "late ID lookup must not select its original target");
    await chat(page, OTHER);
  },
);

it(
  "list load error offers a region-local retry without reopening the chat",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    let fail = true;
    await page.route("**/api/session/list", async (route) => {
      if (rpcArgs(route).sessionId || !fail) return route.continue();
      await route.fulfill({ status: 503, body: "synthetic list failure" });
    });
    await page.goto(direct(url));
    await chat(page);
    const error = page.getByRole("alert").filter({ hasText: /HTTP 503/ });
    await error.waitFor({ timeout: WAIT });
    const retry = error.getByRole("button", { name: /retry|reload/i });
    await retry.waitFor({ timeout: WAIT });
    fail = false;
    await retry.click({ timeout: WAIT });
    await error.waitFor({ state: "hidden", timeout: WAIT });
    await chat(page);
  },
);

async function fixture(t: TestContext, authenticated = false) {
  // Prevent environment-selected packed artifacts from silently replacing the source under test.
  assert.equal(process.env.CODEXHOST_TEST_WEB_BUNDLE, undefined);
  assert.equal(process.env.CODEXHOST_TEST_WEB_EXTENSION_DIRECTORY, undefined);
  const host = new FakeChHost();
  for (const [id, answer] of [
    [FIRST, ANSWER],
    [SECOND, OTHER],
  ] as const) {
    const row = host.add(id, "/synthetic/progressive", id);
    const message = row.turns[0]?.items.find((item) => item.type === "agentMessage");
    assert.ok(message);
    message.text = answer;
  }
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  let exited: Promise<void> | undefined;
  const url = await startServer(
    t,
    resolve(import.meta.dirname, "../.."),
    ["--import", "tsx", "src/main.ts"],
    ["--session-source", "codexhost", "--ch-cdp", debug.endpoint],
    {
      authenticated,
      onSpawn(child) {
        t.diagnostic(`registered disposable gateway pid=${child.pid}`);
        exited = new Promise((done) =>
          child.once("exit", () => {
            t.diagnostic("owned gateway exit confirmed");
            done();
          }),
        );
      },
    },
  );
  t.after(async () => {
    assert.ok(exited);
    await exited;
  });
  const browser = await chromium.launch({
    ...(process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  t.after(async () => {
    await browser.close();
    assert.equal(browser.isConnected(), false);
    t.diagnostic("owned browser close confirmed");
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const errors: string[] = [];
  const rpcStarts: Record<string, number> = {};
  const rpcStatuses: Record<string, number> = {};
  const streamOpens: Record<string, number> = {};
  const rpcKey = (request: { url(): string; postDataJSON(): unknown }): string | undefined => {
    const endpoint = new URL(request.url()).pathname;
    if (endpoint === "/api/session/list") {
      const body = request.postDataJSON() as Parameters<typeof rpcArgsFromRequest>[0];
      return rpcArgsFromRequest(body).sessionId ? "list-exact" : "list-head";
    }
    if (endpoint === "/api/session/create") return "create";
    if (endpoint === "/api/session/page") return "history-page";
    return undefined;
  };
  page.on("request", (request) => {
    const key = rpcKey(request);
    if (key) rpcStarts[key] = (rpcStarts[key] ?? 0) + 1;
  });
  page.on("response", (response) => {
    const key = rpcKey(response.request());
    if (key) {
      const outcome = `${key}:${response.status()}`;
      rpcStatuses[outcome] = (rpcStatuses[outcome] ?? 0) + 1;
    }
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "open" && ["session/follow", "workspace/follow"].includes(frame.endpoint))
        streamOpens[frame.endpoint] = (streamOpens[frame.endpoint] ?? 0) + 1;
    });
  });
  diagnosticPages.set(page, async (stage) => {
    const ui = await page.evaluate(() => ({
      appFrame: document.querySelector("[data-shell-bottom]") !== null,
      bootPage: document.querySelector("[data-dsh-boot]") !== null,
      openingStates: [...document.querySelectorAll("[data-session-opening]")].map((node) =>
        node.getAttribute("data-session-opening"),
      ),
      composerEditable:
        document.querySelector("[data-composer-input]")?.getAttribute("contenteditable") ?? null,
    }));
    t.diagnostic(
      JSON.stringify({
        stage,
        ...ui,
        rpcStarts,
        rpcStatuses,
        streamOpens,
        fixtureHistoryReads: host.requests.filter(({ method }) =>
          ["thread/read", "thread/turns/list"].includes(method),
        ).length,
        browserErrorCount: errors.length,
      }),
    );
  });
  page.on("pageerror", (error) => errors.push(error.name));
  t.after(() => {
    assert.deepEqual(errors, [], "no uncaught browser exception");
    assert.equal(
      host.requests.some(({ method }) => method === "turn/start"),
      false,
    );
  });
  return { host, page, url };
}

function direct(url: string, id = FIRST): string {
  const target = new URL(url);
  target.searchParams.set("session", id);
  return target.href;
}

async function shell(page: Page): Promise<void> {
  // The bottom seat is always mounted; its parent is the visible AppFrame (the seat may be empty).
  try {
    await page.locator("[data-shell-bottom]").locator("..").waitFor({ timeout: WAIT });
  } catch (error) {
    const boot = page.locator("[data-dsh-boot]");
    // This page contains only plugin diagnostics, never Session content.
    if (await boot.count())
      throw new Error(`Application boot did not finish: ${await boot.innerText()}`, {
        cause: error,
      });
    throw error;
  }
}

async function chat(page: Page, answer = ANSWER): Promise<void> {
  try {
    await page.getByText(answer, { exact: true }).waitFor({ timeout: WAIT });
  } catch (error) {
    await diagnose(page, "chat-not-visible");
    throw error;
  }
}

async function openModels(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^(Select model|Loading models)/ })
    .click({ timeout: WAIT });
  const thinking = page.getByRole("menu", { name: "Thinking", exact: true });
  await thinking.getByRole("menuitem").click({ timeout: WAIT });
}

function rpcArgs(route: Route): Record<string, unknown> {
  return rpcArgsFromRequest(route.request().postDataJSON());
}

function rpcArgsFromRequest(body: {
  payload: { args: Record<string, unknown> };
}): Record<string, unknown> {
  const args = body.payload.args;
  return (args.request ?? args._request ?? args) as Record<string, unknown>;
}

/** Hold an actual unary request, including its server work, until explicit release. */
async function holdRpc(
  page: Page,
  endpoint: string,
  match: (route: Route) => boolean = () => true,
) {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  let held = false;
  let started = 0;
  let returned = 0;
  await page.route(`**/api/${endpoint}`, async (route) => {
    if (!match(route)) return route.continue();
    held = true;
    started ||= performance.now();
    reached.resolve(undefined);
    await released.promise;
    await route.continue();
    returned++;
  });
  return {
    reached: async () => {
      try {
        await bounded(reached.promise);
      } catch (error) {
        await diagnose(page, "expected-rpc-not-started");
        throw error;
      }
    },
    pending: () => assert.ok(held && returned === 0, "auxiliary RPC is still held"),
    async release() {
      if (started) await delay(Math.max(0, WAIT - (performance.now() - started)));
      released.resolve(undefined);
    },
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("expected fixture boundary was not reached")),
          WAIT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Intercept one logical region, preserving the real mux and all other streams. */
async function holdStream(page: Page, endpoint: string, sessionId?: string) {
  const reached = Promise.withResolvers<undefined>();
  const pending: Array<() => void> = [];
  let holding = true;
  let deliveries = 0;
  await page.routeWebSocket("**/api/remote.mux", (socket) => {
    const server = socket.connectToServer();
    const selected = new Set<string>();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (
        frame.type === "open" &&
        frame.endpoint === endpoint &&
        (sessionId === undefined ||
          (frame.payload?.args?.request ?? frame.payload?.args?._request ?? frame.payload?.args)
            ?.address?.sessionId === sessionId)
      )
        selected.add(frame.streamId);
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (holding && selected.has(frame.streamId)) {
        pending.push(() => {
          socket.send(message);
          deliveries++;
        });
        reached.resolve(undefined);
      } else socket.send(message);
    });
  });
  return {
    reached: () => bounded(reached.promise),
    pending: () => assert.ok(pending.length > 0 && deliveries === 0, "region baseline is held"),
    release() {
      holding = false;
      pending.splice(0).forEach((send) => send());
    },
  };
}

it(
  "authenticated cold direct entry renders synthetic history without sending a turn",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t, true);
    await page.goto(direct(url));
    await shell(page);
    try {
      await chat(page);
    } catch (error) {
      // Keep the cold-entry failure, then test whether the same known target can be opened by a real user action.
      await openFromSidebar(page);
      await chat(page);
      await diagnose(page, "cold-entry-failed-but-known-sidebar-history-visible");
      throw error;
    }
    await diagnose(page, "cold-entry-history-visible");
    await page.locator("[data-composer-input]").fill("synthetic unsent draft");
    assert.equal(await page.locator("[data-composer-input]").innerText(), "synthetic unsent draft");
    t.diagnostic("authenticated entry: shell, history and editable draft observed; no send tested");
  },
);

it(
  "first mount shows loading, not an empty catalog, while session/list is pending",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    const gate = await holdRpc(page, "session/list");
    try {
      await page.goto(url);
      await gate.reached();
      await shell(page);
      await page
        .getByRole("status")
        .filter({ hasText: "Loading conversation history" })
        .waitFor({ timeout: WAIT });
      gate.pending();
      assert.equal(
        await page.locator('[data-row-key="empty"]').count(),
        0,
        "pending is not an empty result",
      );
    } finally {
      await gate.release();
    }
  },
);

it(
  "cold direct history appears before a five-second catalog list is released",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    // Exact-ID summary lookup is intentionally allowed; only the directory head is delayed.
    const gate = await holdRpc(page, "session/list", (route) => !rpcArgs(route).sessionId);
    try {
      await page.goto(direct(url));
      await gate.reached();
      await shell(page);
      await chat(page);
      gate.pending();
      t.diagnostic("shell and first history visible before catalog release");
    } finally {
      await gate.release();
    }
    await chat(page);
  },
);

it(
  "persisted current history restores by ID before the directory list is released",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    // A real sidebar visit saves the selection independently of the cold direct-link path.
    await page.goto(url);
    await openFromSidebar(page);
    await chat(page);
    const gate = await holdRpc(page, "session/list", (route) => !rpcArgs(route).sessionId);
    let failure: unknown;
    try {
      await page.reload();
      await gate.reached();
      await shell(page);
      await chat(page);
      gate.pending();
      await diagnose(page, "restore-catalog-held-and-history-visible");
    } catch (error) {
      failure = error;
    } finally {
      await gate.release();
    }
    await chat(page);
    t.diagnostic(
      `restore/catalog: core-before-release=${failure === undefined}; core-after-release=true`,
    );
    if (failure) throw failure;
  },
);

it(
  "persisted current history does not wait for the project baseline",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    await page.goto(url);
    await openFromSidebar(page);
    await chat(page);
    const gate = await holdStream(page, "workspace/follow");
    let failure: unknown;
    try {
      await page.reload();
      await gate.reached();
      await shell(page);
      await chat(page);
      gate.pending();
      await diagnose(page, "restore-projects-held-and-history-visible");
    } catch (error) {
      failure = error;
    } finally {
      gate.release();
    }
    await chat(page);
    t.diagnostic(
      `restore/projects: core-before-release=${failure === undefined}; core-after-release=true`,
    );
    if (failure) throw failure;
  },
);

it(
  "model catalog pending remains local while direct history renders",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    const gate = await holdRpc(page, "session/modelCatalog");
    try {
      await page.goto(direct(url));
      await gate.reached();
      await shell(page);
      await chat(page);
      gate.pending();
      // Discovery may open a local loading surface, but cannot offer selectable models yet.
      await openModels(page);
      await page.getByText("Refreshing model list…", { exact: true }).waitFor({ timeout: WAIT });
      assert.equal(
        await page
          .getByRole("menu", { name: "Model", exact: true })
          .getByRole("menuitemradio")
          .count(),
        0,
      );
      await chat(page);
      gate.pending();
    } finally {
      await gate.release();
    }
    await chat(page);
  },
);

it(
  "model catalog failure exposes local retry without removing the chat",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    let failed = 0;
    let fail = true;
    await page.route("**/api/session/modelCatalog", async (route) => {
      if (!fail) return route.continue();
      failed++;
      await route.fulfill({ status: 503, body: "synthetic auxiliary failure" });
    });
    await page.goto(direct(url));
    await shell(page);
    await chat(page);
    assert.ok(failed > 0);
    await openModels(page);
    const reload = page
      .getByRole("group", { name: "Model", exact: true })
      .getByRole("button", { name: "Reload", exact: true });
    await reload.waitFor({ timeout: WAIT });
    await chat(page);
    fail = false;
    await reload.click({ timeout: WAIT });
    await reload.waitFor({ state: "hidden", timeout: WAIT });
    await chat(page);
  },
);

it(
  "runtime permission discovery pending cannot hide history or enable permission changes",
  { timeout: 30_000 },
  async (t) => {
    const { host, page, url } = await fixture(t);
    const request = host.request.bind(host);
    const reached = Promise.withResolvers<undefined>();
    const released = Promise.withResolvers<undefined>();
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "codexhost/harness/inspect" && params.harnessId === "fake") {
        reached.resolve(undefined);
        await released.promise;
      }
      return request<T>(method, params);
    };
    try {
      await page.goto(direct(url));
      await bounded(reached.promise);
      await chat(page);
      const permission = page.getByRole("button", { name: /^Access mode, current:/ });
      assert.equal(await permission.and(page.locator(":enabled")).count(), 0);
    } finally {
      released.resolve(undefined);
    }
    await page
      .getByRole("button", { name: "Access mode, current: Ask", exact: true })
      .waitFor({ timeout: WAIT });
    await chat(page);
  },
);

it(
  "one list failure leaves direct history visible and reports a local list error",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    let failed = 0;
    await page.route("**/api/session/list", async (route) => {
      if (rpcArgs(route).sessionId) return route.continue();
      failed++;
      await route.fulfill({ status: 503, body: "synthetic list failure" });
    });
    await page.goto(direct(url));
    await shell(page);
    await chat(page);
    assert.ok(failed > 0);
    await page
      .getByRole("alert")
      .filter({ hasText: /HTTP 503/ })
      .waitFor({ timeout: WAIT });
    await chat(page);
  },
);

it(
  "switching to B keeps B selected when A's initial history arrives late",
  { timeout: 30_000 },
  async (t) => {
    const { page, url } = await fixture(t);
    const gate = await holdStream(page, "session/follow", FIRST);
    try {
      await page.goto(direct(url));
      await gate.reached();
      await shell(page);
      const folder = page.getByRole("treeitem").filter({ hasText: /^progressive$/ });
      await folder.waitFor({ timeout: WAIT });
      if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
      await page.locator(`[data-row-key="session:${SECOND}"]`).click();
      await chat(page, OTHER);
      await page.locator("[data-composer-input]").fill("B unsent draft");
      gate.pending();
    } finally {
      gate.release();
    }
    // Let the released transport messages and React rendering settle, without a fixed sleep.
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await chat(page, OTHER);
    assert.equal(await page.getByText(ANSWER, { exact: true }).count(), 0);
    assert.equal(await page.locator("[data-composer-input]").innerText(), "B unsent draft");
  },
);
