import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installCurrentRendererAdapter } from "./packages/renderer-extension/src/versioned-renderer-adapter.ts";
      import { RENDERER_REASONING_DISPLAY_PREFERENCE_KEY } from "./packages/renderer-extension/src/renderer-reasoning-preference.ts";

      const counters = new Map();
      const managers = new Map();
      let managerSequence = 0;
      let policySequence = 0;
      let throwOnSelect = false;
      let throwOnNonNullSelect = false;

      const createManager = (hostId) => {
        const id = \`manager-\${++managerSequence}\`;
        const counter = {
          notificationAdds: 0,
          notificationRemoves: 0,
          ownershipInspects: 0,
          ownershipInspectThreads: [],
        };
        const notificationCallbacks = new Set();
        const removedNotificationCallbacks = new Set();
        const ownershipRequests = [];
        counters.set(id, counter);
        const manager = {
          id,
          hostId,
          sendRequest: async (method, params) => {
            if (method !== "codexhost/thread/inspect") throw new Error("unused request");
            counter.ownershipInspects += 1;
            counter.ownershipInspectThreads.push(params.threadId);
            return new Promise((resolve) => {
              ownershipRequests.push({ threadId: params.threadId, resolve });
            });
          },
          prewarmThreadStart: () => undefined,
          enqueueRequest: () => undefined,
          addNotificationCallback: (_methods, callback) => {
            counter.notificationAdds += 1;
            notificationCallbacks.add(callback);
            let removed = false;
            return () => {
              if (removed) return;
              removed = true;
              notificationCallbacks.delete(callback);
              removedNotificationCallbacks.add(callback);
              counter.notificationRemoves += 1;
            };
          },
          emit(notification) {
            for (const callback of notificationCallbacks) callback(notification);
          },
          emitRemoved(notification) {
            for (const callback of removedNotificationCallbacks) callback(notification);
          },
          resolveOwnership(threadId, owner = "external") {
            const index = ownershipRequests.findIndex((request) => request.threadId === threadId);
            if (index < 0) throw new Error(\`No pending ownership request for \${threadId}\`);
            const [request] = ownershipRequests.splice(index, 1);
            request.resolve(
              owner === "external"
                ? {
                    owner: "external",
                    harnessId: "claude-code",
                    transportModelId: "codexhost/claude-code-native",
                    history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
                    locked: true,
                  }
                : { owner: "codex", locked: true },
            );
          },
        };
        managers.set(id, manager);
        return manager;
      };

      const createPolicy = (hostId, requestTarget) => {
        const id = \`policy-\${++policySequence}\`;
        const counter = { selections: 0, requestTargetReads: 0 };
        counters.set(id, counter);
        const policy = {
          id,
          state: "ready",
          hostId,
          select: (selection) => {
            counter.selections += 1;
            if (throwOnSelect || (throwOnNonNullSelect && selection !== null)) {
              throw new Error("synthetic policy selection failure");
            }
            return true;
          },
          clear: async () => undefined,
        };
        if (requestTarget !== undefined) {
          policy.requestTarget = () => {
            counter.requestTargetReads += 1;
            return requestTarget;
          };
        }
        return policy;
      };

      globalThis.setupAdapterLifecycle = (reasoningEnabled = false) => {
        document.body.replaceChildren();
        if (reasoningEnabled) {
          localStorage.setItem(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY, "true");
        } else {
          localStorage.removeItem(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY);
        }
        const editor = document.createElement("div");
        editor.setAttribute("data-codex-composer", "true");
        editor.setAttribute("data-codex-composer-root", "true");
        editor.setAttribute("contenteditable", "true");
        editor.setAttribute("role", "textbox");
        const portal = document.createElement("div");
        portal.setAttribute("data-above-composer-portal", "true");
        portal.setAttribute("data-above-composer-conversation-id", "thread-displayed-old");
        editor.append(portal);
        const initialManager = createManager("remote-ssh-discovered:initial");
        const managerHook = { memoizedState: initialManager, next: null };
        Object.defineProperty(editor, "__reactFiber$lifecycle", {
          configurable: true,
          value: { memoizedState: managerHook, return: null },
        });
        document.body.append(editor);

        const initialPolicy = createPolicy(initialManager.hostId);
        window.__codexhostMainProcessTitlePolicyV1 = { state: "ready" };
        window.__codexhostDraftPrewarmPolicyV1 = initialPolicy;
        const adapter = installCurrentRendererAdapter();
        const unsubscribeReasoning = adapter.modelControl?.subscribeThreadReasoning?.(() => {});

        const state = {
          adapter,
          initialManager,
          initialPolicy,
          portal,
          managerHook,
          unsubscribeReasoning,
          replacementManager: null,
          replacementPolicy: null,
        };
        globalThis.__adapterLifecycleState = state;
        return {
          initialManagerId: initialManager.id,
          initialPolicyId: initialPolicy.id,
        };
      };

      globalThis.replaceAdapterRoute = (withManager) => {
        const state = globalThis.__adapterLifecycleState;
        const replacementManager = createManager("remote-ssh-discovered:replacement");
        const replacementPolicy = createPolicy(replacementManager.hostId);
        state.replacementManager = replacementManager;
        state.replacementPolicy = replacementPolicy;
        state.managerHook.memoizedState = withManager ? replacementManager : {};
        window.__codexhostDraftPrewarmPolicyV1 = replacementPolicy;
        return {
          replacementManagerId: replacementManager.id,
          replacementPolicyId: replacementPolicy.id,
        };
      };

      globalThis.replaceAdapterRouteWithExactTarget = (mode) => {
        const state = globalThis.__adapterLifecycleState;
        const replacementManager = createManager("remote-ssh-discovered:replacement");
        const exactTarget =
          mode === "valid"
            ? replacementManager
            : mode === "host-mismatch"
              ? createManager("remote-ssh-discovered:other")
              : {};
        const replacementPolicy = createPolicy(replacementManager.hostId, exactTarget);
        state.replacementManager = replacementManager;
        state.replacementPolicy = replacementPolicy;
        state.managerHook.memoizedState = mode === "valid" ? {} : replacementManager;
        window.__codexhostDraftPrewarmPolicyV1 = replacementPolicy;
        return {
          replacementManagerId: replacementManager.id,
          replacementPolicyId: replacementPolicy.id,
        };
      };

      globalThis.revealReplacementManager = () => {
        const state = globalThis.__adapterLifecycleState;
        state.managerHook.memoizedState = state.replacementManager;
      };
      globalThis.publishRendererMutation = () => {
        const marker = document.createElement("div");
        marker.textContent = "route discovery changed";
        document.body.append(marker);
      };

      globalThis.readCurrentHostId = () =>
        globalThis.__adapterLifecycleState.adapter.modelControl?.currentHostId?.() ?? null;
      globalThis.setLifecycleComposerThread = (threadId) =>
        globalThis.__adapterLifecycleState.portal.setAttribute(
          "data-above-composer-conversation-id",
          threadId,
        );
      globalThis.emitLifecycleReasoning = (managerId, notification, removed = false) => {
        const manager = managers.get(managerId);
        if (!manager) throw new Error(\`Unknown lifecycle manager \${managerId}\`);
        if (removed) manager.emitRemoved(notification);
        else manager.emit(notification);
      };
      globalThis.resolveLifecycleOwnership = (managerId, threadId, owner = "external") => {
        const manager = managers.get(managerId);
        if (!manager) throw new Error(\`Unknown lifecycle manager \${managerId}\`);
        manager.resolveOwnership(threadId, owner);
      };
      globalThis.publishRouteChange = () =>
        window.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
      globalThis.enablePolicyCleanupFailure = () => { throwOnSelect = true; };
      globalThis.enablePolicySelectionFailure = () => { throwOnNonNullSelect = true; };
      globalThis.disposeAdapter = () => {
        try {
          globalThis.__adapterLifecycleState.adapter.dispose();
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      globalThis.readLifecycleCounter = (id) => counters.get(id);
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-adapter-lifecycle-e2e-entry.ts",
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
if (!browserBundle) throw new Error("Renderer adapter lifecycle E2E bundle was not generated");
const browserBundleText: string = browserBundle;

async function setup(
  page: Page,
  reasoningEnabled = false,
): Promise<{
  initialManagerId: string;
  initialPolicyId: string;
}> {
  await page.route("https://codexhost.test/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
  });
  await page.goto("https://codexhost.test/");
  await page.addScriptTag({ content: browserBundleText });
  return page.evaluate((enableReasoning) => {
    const setupAdapterLifecycle = Reflect.get(globalThis, "setupAdapterLifecycle");
    if (typeof setupAdapterLifecycle !== "function") {
      throw new Error("Adapter lifecycle setup is unavailable");
    }
    return setupAdapterLifecycle(enableReasoning);
  }, reasoningEnabled);
}

async function replaceRoute(
  page: Page,
  withManager: boolean,
): Promise<{ replacementManagerId: string; replacementPolicyId: string }> {
  return page.evaluate((managerReady) => {
    const replaceAdapterRoute = Reflect.get(globalThis, "replaceAdapterRoute");
    if (typeof replaceAdapterRoute !== "function") {
      throw new Error("Adapter route replacement is unavailable");
    }
    return replaceAdapterRoute(managerReady);
  }, withManager);
}

async function counter(
  page: Page,
  id: string,
): Promise<{
  notificationAdds?: number;
  notificationRemoves?: number;
  ownershipInspects?: number;
  ownershipInspectThreads?: string[];
  selections?: number;
  requestTargetReads?: number;
}> {
  return page.evaluate((counterId) => {
    const readLifecycleCounter = Reflect.get(globalThis, "readLifecycleCounter");
    if (typeof readLifecycleCounter !== "function") {
      throw new Error("Adapter lifecycle counter is unavailable");
    }
    return readLifecycleCounter(counterId);
  }, id);
}

function reasoningDelta(threadId: string, turnId: string, itemId: string, delta: string): unknown {
  return {
    method: "item/reasoning/summaryTextDelta",
    params: { threadId, turnId, itemId, summaryIndex: 0, delta },
  };
}

async function emitReasoning(
  page: Page,
  managerId: string,
  notification: unknown,
  removed = false,
): Promise<void> {
  await page.evaluate(
    ({ id, payload, useRemoved }) => {
      const emit = Reflect.get(globalThis, "emitLifecycleReasoning");
      if (typeof emit !== "function") throw new Error("Lifecycle Reasoning emitter is unavailable");
      emit(id, payload, useRemoved);
    },
    { id: managerId, payload: notification, useRemoved: removed },
  );
}

async function resolveOwnership(page: Page, managerId: string, threadId: string): Promise<void> {
  await page.evaluate(
    ({ id, thread }) => {
      const resolve = Reflect.get(globalThis, "resolveLifecycleOwnership");
      if (typeof resolve !== "function") {
        throw new Error("Lifecycle ownership resolver is unavailable");
      }
      resolve(id, thread, "external");
    },
    { id: managerId, thread: threadId },
  );
}

async function replaceRouteWithExactTarget(
  page: Page,
  mode: "valid" | "malformed" | "host-mismatch",
): Promise<{ replacementManagerId: string; replacementPolicyId: string }> {
  return page.evaluate((targetMode) => {
    const replace = Reflect.get(globalThis, "replaceAdapterRouteWithExactTarget");
    if (typeof replace !== "function") {
      throw new Error("Adapter exact route replacement is unavailable");
    }
    return replace(targetMode);
  }, mode);
}

async function publishRouteChange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const publish = Reflect.get(globalThis, "publishRouteChange");
    if (typeof publish !== "function") {
      throw new Error("Adapter route-change publisher is unavailable");
    }
    publish();
  });
}

test("an active-route read moves the reasoning relay to the resolved request manager", async ({
  page,
}) => {
  const initial = await setup(page);
  const replacement = await replaceRoute(page, true);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const readCurrentHostId = Reflect.get(globalThis, "readCurrentHostId");
        if (typeof readCurrentHostId !== "function") return null;
        return readCurrentHostId();
      }),
    )
    .toBe("remote-ssh-discovered:replacement");
  await expect
    .poll(async () => counter(page, initial.initialManagerId))
    .toMatchObject({
      notificationRemoves: 1,
    });
  await expect
    .poll(async () => counter(page, replacement.replacementManagerId))
    .toMatchObject({
      notificationAdds: 1,
    });
});

test("one policy event reconnects an exact request target without Fiber discovery or DOM mutation", async ({
  page,
}) => {
  const initial = await setup(page);
  const replacement = await replaceRouteWithExactTarget(page, "valid");

  await publishRouteChange(page);
  await publishRouteChange(page);

  await expect
    .poll(async () => counter(page, initial.initialManagerId))
    .toMatchObject({
      notificationRemoves: 1,
    });
  await expect
    .poll(async () => counter(page, replacement.replacementManagerId))
    .toMatchObject({
      notificationAdds: 1,
    });
  expect(await counter(page, replacement.replacementPolicyId)).toMatchObject({
    selections: 1,
  });
});

test("an exact Host replacement clears stale Reasoning ownership and safely reuses the Thread ID", async ({
  page,
}) => {
  const displayedThreadId = "thread-displayed-old";
  const reusedThreadId = "thread-reused-across-hosts";
  const initial = await setup(page, true);
  const panel = page.locator("[data-codexhost-reasoning-display]");

  await emitReasoning(
    page,
    initial.initialManagerId,
    reasoningDelta(displayedThreadId, "turn-displayed-old", "reasoning-displayed-old", "old panel"),
  );
  await expect
    .poll(async () => counter(page, initial.initialManagerId))
    .toMatchObject({
      ownershipInspects: 1,
      ownershipInspectThreads: [displayedThreadId],
    });
  await resolveOwnership(page, initial.initialManagerId, displayedThreadId);
  await expect(panel).toContainText("old panel");

  await emitReasoning(
    page,
    initial.initialManagerId,
    reasoningDelta(reusedThreadId, "turn-pending-old", "reasoning-pending-old", "pending old"),
  );
  await expect
    .poll(async () => counter(page, initial.initialManagerId))
    .toMatchObject({
      ownershipInspects: 2,
      ownershipInspectThreads: [displayedThreadId, reusedThreadId],
    });

  const replacement = await replaceRouteWithExactTarget(page, "valid");
  await publishRouteChange(page);

  await expect(panel).toHaveCount(0);
  await expect
    .poll(async () => counter(page, initial.initialManagerId))
    .toMatchObject({
      notificationRemoves: 1,
    });
  await expect
    .poll(async () => counter(page, replacement.replacementManagerId))
    .toMatchObject({
      notificationAdds: 1,
    });

  await emitReasoning(
    page,
    initial.initialManagerId,
    reasoningDelta(reusedThreadId, "turn-stale-old", "reasoning-stale-old", "released stale old"),
    true,
  );
  await resolveOwnership(page, initial.initialManagerId, reusedThreadId);
  await page.evaluate((threadId) => {
    const setThread = Reflect.get(globalThis, "setLifecycleComposerThread");
    if (typeof setThread !== "function") {
      throw new Error("Lifecycle Composer Thread control is unavailable");
    }
    setThread(threadId);
  }, reusedThreadId);

  await emitReasoning(
    page,
    replacement.replacementManagerId,
    reasoningDelta(reusedThreadId, "turn-current-new", "reasoning-current-new", "current new"),
  );
  await expect
    .poll(async () => counter(page, replacement.replacementManagerId))
    .toMatchObject({
      ownershipInspects: 1,
      ownershipInspectThreads: [reusedThreadId],
    });
  await resolveOwnership(page, replacement.replacementManagerId, reusedThreadId);

  await expect(panel).toContainText("current new");
  await expect(panel).not.toContainText("old panel");
  await expect(panel).not.toContainText("pending old");
  await expect(panel).not.toContainText("released stale old");
  expect(await counter(page, initial.initialManagerId)).toMatchObject({ ownershipInspects: 2 });
});

for (const mode of ["malformed", "host-mismatch"] as const) {
  test(`a ${mode} exact request target fails closed without falling back to Fiber discovery`, async ({
    page,
  }) => {
    const initial = await setup(page);
    const replacement = await replaceRouteWithExactTarget(page, mode);

    await publishRouteChange(page);
    await page.evaluate(() => {
      const publishRendererMutation = Reflect.get(globalThis, "publishRendererMutation");
      if (typeof publishRendererMutation !== "function") {
        throw new Error("Renderer mutation publisher is unavailable");
      }
      publishRendererMutation();
    });
    await page.waitForTimeout(100);

    expect(await counter(page, replacement.replacementPolicyId)).toMatchObject({ selections: 0 });
    expect(await counter(page, replacement.replacementManagerId)).toMatchObject({
      notificationAdds: 0,
    });
    expect(await counter(page, initial.initialManagerId)).toMatchObject({
      notificationRemoves: 1,
    });
  });
}

test("a renderer mutation recaptures a request manager after a transient discovery gap", async ({
  page,
}) => {
  await setup(page);
  const replacement = await replaceRoute(page, false);
  await page.evaluate(() => {
    const publishRouteChange = Reflect.get(globalThis, "publishRouteChange");
    if (typeof publishRouteChange !== "function") {
      throw new Error("Adapter route-change publisher is unavailable");
    }
    publishRouteChange();
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const revealReplacementManager = Reflect.get(globalThis, "revealReplacementManager");
    if (typeof revealReplacementManager !== "function") {
      throw new Error("Adapter replacement manager is unavailable");
    }
    revealReplacementManager();
  });
  await page.waitForTimeout(150);
  expect(await counter(page, replacement.replacementPolicyId)).toMatchObject({ selections: 0 });
  expect(await counter(page, replacement.replacementManagerId)).toMatchObject({
    notificationAdds: 0,
  });
  await page.evaluate(() => {
    const publishRendererMutation = Reflect.get(globalThis, "publishRendererMutation");
    if (typeof publishRendererMutation !== "function") {
      throw new Error("Renderer mutation publisher is unavailable");
    }
    publishRendererMutation();
  });
  await expect
    .poll(async () => counter(page, replacement.replacementPolicyId))
    .toMatchObject({
      selections: 1,
    });
  await expect
    .poll(async () => counter(page, replacement.replacementManagerId))
    .toMatchObject({
      notificationAdds: 1,
    });
});

test("a failed replacement selection disconnects the temporary mutation observer", async ({
  page,
}) => {
  await setup(page);
  const replacement = await replaceRoute(page, false);
  await page.evaluate(() => {
    const publishRouteChange = Reflect.get(globalThis, "publishRouteChange");
    const revealReplacementManager = Reflect.get(globalThis, "revealReplacementManager");
    const enablePolicySelectionFailure = Reflect.get(globalThis, "enablePolicySelectionFailure");
    if (
      typeof publishRouteChange !== "function" ||
      typeof revealReplacementManager !== "function" ||
      typeof enablePolicySelectionFailure !== "function"
    ) {
      throw new Error("Adapter selection-failure controls are unavailable");
    }
    publishRouteChange();
    revealReplacementManager();
    enablePolicySelectionFailure();
  });
  await page.evaluate(() => {
    const publishRendererMutation = Reflect.get(globalThis, "publishRendererMutation");
    if (typeof publishRendererMutation !== "function") {
      throw new Error("Renderer mutation publisher is unavailable");
    }
    publishRendererMutation();
  });
  await expect
    .poll(async () => counter(page, replacement.replacementPolicyId))
    .toMatchObject({
      selections: 1,
    });

  await page.evaluate(() => {
    const publishRendererMutation = Reflect.get(globalThis, "publishRendererMutation");
    if (typeof publishRendererMutation !== "function") {
      throw new Error("Renderer mutation publisher is unavailable");
    }
    publishRendererMutation();
  });
  await page.waitForTimeout(150);
  expect(await counter(page, replacement.replacementPolicyId)).toMatchObject({ selections: 1 });
});

test("adapter disposal continues after the routing policy rejects cleanup", async ({ page }) => {
  const initial = await setup(page);
  const cleanupError = await page.evaluate(() => {
    const enablePolicyCleanupFailure = Reflect.get(globalThis, "enablePolicyCleanupFailure");
    const disposeAdapter = Reflect.get(globalThis, "disposeAdapter");
    if (typeof enablePolicyCleanupFailure !== "function" || typeof disposeAdapter !== "function") {
      throw new Error("Adapter cleanup controls are unavailable");
    }
    enablePolicyCleanupFailure();
    return disposeAdapter();
  });

  expect(cleanupError).toBeNull();
  await expect
    .poll(async () => counter(page, initial.initialManagerId))
    .toMatchObject({
      notificationRemoves: 1,
    });
});
