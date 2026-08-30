import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererReasoningDisplay } from "./packages/renderer-extension/src/renderer-reasoning-display.ts";
      import { decodeRendererReasoningNotification } from "./packages/renderer-extension/src/renderer-reasoning-events.ts";
      import {
        RENDERER_REASONING_DISPLAY_PREFERENCE_KEY,
        setRendererReasoningDisplayPreference,
      } from "./packages/renderer-extension/src/renderer-reasoning-preference.ts";

      globalThis.setupReasoningDisplay = (
        owner = "external",
        initiallyEnabled = true,
        ownershipInspectionTimeoutMs = 5000,
        maxPendingTextLength = 262144,
      ) => {
        if (initiallyEnabled) {
          localStorage.setItem(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY, "true");
        } else {
          localStorage.removeItem(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY);
        }
        const wrapper = document.createElement("main");
        const composer = document.createElement("div");
        composer.setAttribute("data-codex-composer-root", "true");
        const portal = document.createElement("div");
        portal.setAttribute("data-above-composer-portal", "true");
        portal.setAttribute("data-above-composer-conversation-id", "thread-reasoning-1");
        composer.append(portal);
        wrapper.append(composer);
        document.body.append(wrapper);

        let listener = null;
        let subscriptionCount = 0;
        let currentOwner = owner;
        let holdOwnershipInspection = false;
        const ownershipResolvers = [];
        const control = installRendererReasoningDisplay({
          inspectThread: async () => {
            const inspectedOwner = currentOwner;
            if (holdOwnershipInspection) {
              await new Promise((resolve) => ownershipResolvers.push(resolve));
            }
            return inspectedOwner === "external"
              ? {
                  owner: "external",
                  harnessId: "claude-code",
                  transportModelId: "codexhost/claude-code-native",
                  history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
                  locked: true,
                }
              : { owner: "codex", locked: false };
          },
          subscribeThreadReasoning: (next) => {
            subscriptionCount += 1;
            listener = next;
            return () => { listener = null; };
          },
        }, window, { ownershipInspectionTimeoutMs, maxPendingTextLength });
        globalThis.pushReasoningNotification = (notification) => {
          const event = decodeRendererReasoningNotification(notification);
          if (!event || !listener) throw new Error("Reasoning notification was rejected");
          listener(event);
        };
        globalThis.disableReasoningDisplay = () => setRendererReasoningDisplayPreference(false);
        globalThis.enableReasoningDisplay = () => setRendererReasoningDisplayPreference(true);
        globalThis.reasoningSubscriptionCount = () => subscriptionCount;
        globalThis.resetReasoningDisplay = () => control.reset();
        globalThis.setReasoningOwner = (nextOwner) => { currentOwner = nextOwner; };
        globalThis.holdReasoningOwnership = (hold) => { holdOwnershipInspection = hold; };
        globalThis.resolveReasoningOwnership = () => ownershipResolvers.shift()?.();
        globalThis.disposeReasoningDisplay = () => control.dispose();
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-reasoning-display-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer reasoning display bundle was not generated");
const browserBundleText: string = browserBundle;

async function setup(
  page: Page,
  owner: "external" | "codex" = "external",
  initiallyEnabled = true,
  ownershipInspectionTimeoutMs = 5_000,
  maxPendingTextLength = 256 * 1024,
): Promise<void> {
  await page.route("https://codexhost.test/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
  });
  await page.goto("https://codexhost.test/");
  await page.addScriptTag({ content: browserBundleText });
  await page.evaluate(
    ({ threadOwner, enabled, timeoutMs, pendingTextLimit }) => {
      const setupReasoningDisplay = Reflect.get(globalThis, "setupReasoningDisplay");
      if (typeof setupReasoningDisplay !== "function") {
        throw new Error("Reasoning display setup is unavailable");
      }
      setupReasoningDisplay(threadOwner, enabled, timeoutMs, pendingTextLimit);
    },
    {
      threadOwner: owner,
      enabled: initiallyEnabled,
      timeoutMs: ownershipInspectionTimeoutMs,
      pendingTextLimit: maxPendingTextLength,
    },
  );
}

async function push(page: Page, notification: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const pushReasoningNotification = Reflect.get(globalThis, "pushReasoningNotification");
    if (typeof pushReasoningNotification !== "function") {
      throw new Error("Reasoning notification bridge is unavailable");
    }
    pushReasoningNotification(payload);
  }, notification);
}

test("streams explicit external reasoning summaries and collapses on completion", async ({
  page,
}) => {
  await setup(page);
  const panel = page.locator("[data-codexhost-reasoning-display]");
  await expect(panel).toHaveCount(0);

  await push(page, {
    method: "item/started",
    params: {
      threadId: "thread-reasoning-1",
      turnId: "turn-reasoning-1",
      item: { id: "reasoning-1", type: "reasoning", summary: [], content: [] },
    },
  });
  await push(page, {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-reasoning-1",
      turnId: "turn-reasoning-1",
      itemId: "reasoning-1",
      summaryIndex: 0,
      delta: "Inspecting the request",
    },
  });

  await expect(panel).toBeVisible();
  await expect(panel.locator("details")).toHaveAttribute("open", "");
  await expect(panel).toContainText("Inspecting the request");

  await push(page, {
    method: "item/completed",
    params: {
      threadId: "thread-reasoning-1",
      turnId: "turn-reasoning-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        summary: ["Inspecting the request", "Checking the result"],
        content: ["private raw chain"],
        encrypted_content: "secret",
      },
    },
  });

  await expect(panel.locator("details")).not.toHaveAttribute("open", "");
  await expect(panel).toContainText("Reasoning complete");
  await panel.locator("summary").click();
  await expect(panel.locator("details")).toHaveAttribute("open", "");
  await expect(panel).toContainText("Checking the result");
  await expect(panel).not.toContainText("private raw chain");
  await expect(panel).not.toContainText("secret");

  await page.evaluate(() => {
    const unrelated = document.createElement("div");
    unrelated.textContent = "unrelated DOM mutation";
    document.body.append(unrelated);
  });
  await expect(panel.locator("details")).toHaveAttribute("open", "");

  await page.evaluate(() => {
    const disable = Reflect.get(globalThis, "disableReasoningDisplay");
    if (typeof disable !== "function") throw new Error("Reasoning disable action is unavailable");
    disable();
  });
  await expect(panel).toHaveCount(0);
});

test("fails closed for an official Codex-owned thread", async ({ page }) => {
  await setup(page, "codex");
  await push(page, {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-reasoning-1",
      turnId: "turn-reasoning-1",
      itemId: "reasoning-1",
      summaryIndex: 0,
      delta: "Native Codex reasoning",
    },
  });

  await expect(page.locator("[data-codexhost-reasoning-display]")).toHaveCount(0);
});

test("does not subscribe or observe until the user opts in", async ({ page }) => {
  await setup(page, "external", false);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const count = Reflect.get(globalThis, "reasoningSubscriptionCount");
        return typeof count === "function" ? count() : -1;
      }),
    )
    .toBe(0);

  await page.evaluate(() => {
    const enable = Reflect.get(globalThis, "enableReasoningDisplay");
    if (typeof enable !== "function") throw new Error("Reasoning enable action is unavailable");
    enable();
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const count = Reflect.get(globalThis, "reasoningSubscriptionCount");
        return typeof count === "function" ? count() : -1;
      }),
    )
    .toBe(1);
});

test("drops ownership results and summaries from an invalidated Host route", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const hold = Reflect.get(globalThis, "holdReasoningOwnership");
    if (typeof hold !== "function") throw new Error("Reasoning ownership hold is unavailable");
    hold(true);
  });
  await push(page, {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-reasoning-1",
      turnId: "turn-old",
      itemId: "reasoning-old",
      summaryIndex: 0,
      delta: "stale summary",
    },
  });

  await page.evaluate(() => {
    const reset = Reflect.get(globalThis, "resetReasoningDisplay");
    const setOwner = Reflect.get(globalThis, "setReasoningOwner");
    const hold = Reflect.get(globalThis, "holdReasoningOwnership");
    if (
      typeof reset !== "function" ||
      typeof setOwner !== "function" ||
      typeof hold !== "function"
    ) {
      throw new Error("Reasoning route controls are unavailable");
    }
    reset();
    setOwner("codex");
    hold(false);
  });
  await push(page, {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-reasoning-1",
      turnId: "turn-current",
      itemId: "reasoning-current",
      summaryIndex: 0,
      delta: "native summary",
    },
  });
  await page.evaluate(() => {
    const resolve = Reflect.get(globalThis, "resolveReasoningOwnership");
    if (typeof resolve !== "function")
      throw new Error("Reasoning ownership resolver is unavailable");
    resolve();
  });

  await expect(page.locator("[data-codexhost-reasoning-display]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("stale summary");
});

test("fails closed when ownership inspection times out", async ({ page }) => {
  await setup(page, "external", true, 25);
  await page.evaluate(() => {
    const hold = Reflect.get(globalThis, "holdReasoningOwnership");
    if (typeof hold !== "function") throw new Error("Reasoning ownership hold is unavailable");
    hold(true);
  });
  await push(page, {
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-reasoning-1",
      turnId: "turn-reasoning-1",
      itemId: "reasoning-1",
      summaryIndex: 0,
      delta: "timed out summary",
    },
  });

  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const resolve = Reflect.get(globalThis, "resolveReasoningOwnership");
    if (typeof resolve !== "function")
      throw new Error("Reasoning ownership resolver is unavailable");
    resolve();
  });
  await expect(page.locator("[data-codexhost-reasoning-display]")).toHaveCount(0);
});

test("fails closed when pending reasoning exceeds its bounded buffer", async ({ page }) => {
  await setup(page, "external", true, 5_000, 8);
  await page.evaluate(() => {
    const hold = Reflect.get(globalThis, "holdReasoningOwnership");
    if (typeof hold !== "function") throw new Error("Reasoning ownership hold is unavailable");
    hold(true);
  });
  for (const delta of ["12345678", "9"]) {
    await push(page, {
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-reasoning-1",
        turnId: "turn-reasoning-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta,
      },
    });
  }
  await page.evaluate(() => {
    const resolve = Reflect.get(globalThis, "resolveReasoningOwnership");
    if (typeof resolve !== "function")
      throw new Error("Reasoning ownership resolver is unavailable");
    resolve();
  });

  await expect(page.locator("[data-codexhost-reasoning-display]")).toHaveCount(0);
});
