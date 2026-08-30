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

      const counters = new Map();
      const managers = new Map();
      let managerSequence = 0;
      let policySequence = 0;
      let throwOnSelect = false;
      let throwOnNonNullSelect = false;

      const createManager = (hostId) => {
        const id = \`manager-\${++managerSequence}\`;
        const counter = { requestCalls: 0 };
        counters.set(id, counter);
        const manager = {
          id,
          hostId,
          sendRequest: async () => {
            counter.requestCalls += 1;
            return {
              threadId: "thread-lifecycle",
              usage: { inputTokens: 1 },
            };
          },
          prewarmThreadStart: () => undefined,
          enqueueRequest: () => undefined,
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

      globalThis.setupAdapterLifecycle = () => {
        document.body.replaceChildren();
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

        const state = {
          adapter,
          initialManager,
          initialPolicy,
          portal,
          managerHook,
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

async function setup(page: Page): Promise<{
  initialManagerId: string;
  initialPolicyId: string;
}> {
  await page.route("https://codexhost.test/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
  });
  await page.goto("https://codexhost.test/");
  await page.addScriptTag({ content: browserBundleText });
  return page.evaluate(() => {
    const setupAdapterLifecycle = Reflect.get(globalThis, "setupAdapterLifecycle");
    if (typeof setupAdapterLifecycle !== "function") {
      throw new Error("Adapter lifecycle setup is unavailable");
    }
    return setupAdapterLifecycle();
  });
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
  requestCalls?: number;
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

test("an active-route read moves requests to the resolved request manager", async ({ page }) => {
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
  await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "__adapterLifecycleState");
    await state.adapter.modelControl.inspectThreadUsage({ threadId: "thread-lifecycle" });
  });
  expect(await counter(page, initial.initialManagerId)).toMatchObject({ requestCalls: 0 });
  expect(await counter(page, replacement.replacementManagerId)).toMatchObject({ requestCalls: 1 });
});

test("one policy event reconnects an exact request target without Fiber discovery or DOM mutation", async ({
  page,
}) => {
  const initial = await setup(page);
  const replacement = await replaceRouteWithExactTarget(page, "valid");

  await publishRouteChange(page);
  await publishRouteChange(page);

  await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "__adapterLifecycleState");
    await state.adapter.modelControl.inspectThreadUsage({ threadId: "thread-lifecycle" });
  });
  expect(await counter(page, initial.initialManagerId)).toMatchObject({ requestCalls: 0 });
  expect(await counter(page, replacement.replacementManagerId)).toMatchObject({ requestCalls: 1 });
  expect(await counter(page, replacement.replacementPolicyId)).toMatchObject({
    selections: 1,
  });
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
      requestCalls: 0,
    });
    expect(await counter(page, initial.initialManagerId)).toMatchObject({ requestCalls: 0 });
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
    requestCalls: 0,
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
  await page.evaluate(async () => {
    const state = Reflect.get(globalThis, "__adapterLifecycleState");
    await state.adapter.modelControl.inspectThreadUsage({ threadId: "thread-lifecycle" });
  });
  expect(await counter(page, replacement.replacementManagerId)).toMatchObject({ requestCalls: 1 });
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
  await setup(page);
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
});
