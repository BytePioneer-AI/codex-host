import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

test.beforeEach(async ({ page }) => {
  // The Renderer reads localStorage; about:blank does not provide an origin.
  await page.route("http://codexhost.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
  );
  await page.goto("http://codexhost.test/");
});

await build({
  entryPoints: [path.join(repositoryRoot, "packages/shared-contracts/src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
  outfile: path.join(repositoryRoot, "packages/shared-contracts/dist/index.js"),
});

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from "./packages/renderer-extension/src/renderer-binding-probe.ts";
      installRendererBindingProbe({ enabledAgents: ["codex", "pi"], defaultAgent: "pi" });
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-chat-composer-isolation-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (typeof browserBundle !== "string") {
  throw new Error("Renderer Chat isolation E2E bundle was not generated");
}

async function installChatComposer(page: Page, script: string): Promise<void> {
  await page.setContent(`
    <!doctype html>
    <body>
      <form data-chat-composer>
        <div contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    </body>
  `);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
}

async function dispatchInputIntents(page: Page): Promise<unknown> {
  return page.locator('[role="textbox"]').evaluate((editor) => {
    const dispatch = (event: Event) => {
      const accepted = editor.dispatchEvent(event);
      return { accepted, prevented: event.defaultPrevented };
    };
    return {
      backspace: dispatch(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      ),
      paste: dispatch(
        new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
      beforeInput: dispatch(
        new InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          cancelable: true,
        }),
      ),
    };
  });
}

const unmodifiedInputResults = {
  backspace: { accepted: true, prevented: false },
  paste: { accepted: true, prevented: false },
  beforeInput: { accepted: true, prevented: false },
};

async function setOrbitComposer(page: Page, orbit: boolean): Promise<void> {
  await page.locator('[role="textbox"]').evaluate((editor, isOrbit) => {
    // Dot shares the Codex root marker and conversationId. Its cloud room
    // owner is well above the shared editor components in the React tree.
    let fiber: object = { memoizedProps: { isOrbit, conversationId: "dot-room" }, return: null };
    for (let depth = 0; depth < 80; depth += 1) fiber = { return: fiber };
    Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });
  }, orbit);
}

async function nativeSubmitResults(page: Page, orbit?: boolean): Promise<unknown> {
  return page.locator('[role="textbox"]').evaluate((editor, isOrbit) => {
    if (isOrbit !== undefined) {
      let fiber: object = { memoizedProps: { isOrbit, conversationId: "dot-room" }, return: null };
      for (let depth = 0; depth < 80; depth += 1) fiber = { return: fiber };
      Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });
    }
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    const form = editor.closest("form");
    const send = form?.querySelector('button[type="submit"]');
    if (!form || !send) throw new Error("Missing fixture submission controls");
    // Observe propagation without navigating the fixture or submitting a real message.
    let received = 0;
    const receive = (event: Event) => {
      received += 1;
      event.preventDefault();
    };
    editor.addEventListener("keydown", receive, { once: true });
    form.addEventListener("submit", receive, { once: true });
    send.addEventListener("click", receive, { once: true });
    editor.dispatchEvent(enter);
    form.dispatchEvent(submit);
    send.dispatchEvent(click);
    return { received };
  }, orbit);
}

test("dot cloud composers retain native submission despite the Codex root marker", async ({
  page,
}) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await setOrbitComposer(page, true);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
  expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
});

test("an unclassifiable composer root is never mounted and never intercepts", async ({ page }) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  // The DOM pointer exists, but its return chain is a cycle, so the bounded
  // published-tree walk gives up and the root cannot be classified. It must
  // stay unmounted (no interception, no disabled send button) instead of
  // being treated as a native Codex composer.
  await page.locator('[role="textbox"]').evaluate((editor) => {
    const fiber: { memoizedProps: Record<string, unknown>; return: unknown } = {
      memoizedProps: { isOrbit: true, conversationId: "dot-room" },
      return: null,
    };
    fiber.return = fiber;
    Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });
  });
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
});

test("a mounted composer classified as unknown stops intercepting native sends", async ({
  page,
}) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await setOrbitComposer(page, false);
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
  // A later scan classifies the mounted root as unknown (unpublished cyclic
  // ancestry). The retained state must not make the submission listeners
  // block native sends, and the scan must not churn the controls away. The
  // send button's disabled render belongs to the retained mounted state (its
  // ownership request failed on the pseudo conversation target), so the
  // meaningful assertions here are native propagation and retention.
  const result = await page.locator('[role="textbox"]').evaluate((editor) => {
    const fiber: { memoizedProps: Record<string, unknown>; return: unknown } = {
      memoizedProps: { isOrbit: true, conversationId: "dot-room" },
      return: null,
    };
    fiber.return = fiber;
    Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    const form = editor.closest("form");
    const send = form?.querySelector('button[type="submit"]');
    if (!form || !send) throw new Error("Missing fixture submission controls");
    let received = 0;
    const receive = (event: Event) => {
      received += 1;
      event.preventDefault();
    };
    editor.addEventListener("keydown", receive, { once: true });
    form.addEventListener("submit", receive, { once: true });
    send.addEventListener("click", receive, { once: true });
    editor.dispatchEvent(enter);
    form.dispatchEvent(submit);
    send.dispatchEvent(click);
    return { received };
  });
  expect(result).toEqual({ received: 3 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  // Retention policy: an unknown classification keeps the mounted state until
  // a scan can classify the root again.
  await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "true"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
});

test("a mounted root becoming dot stops intercepting before the next scan", async ({ page }) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await setOrbitComposer(page, false);
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
  expect(await nativeSubmitResults(page, true)).toEqual({ received: 3 });
  // React changes produce DOM mutations; the same root must also lose all controls.
  await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "false"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
  await setOrbitComposer(page, false);
  await page.locator("form").evaluate((root) => root.removeAttribute("aria-hidden"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
});

test("a pending ownership failure cannot block a root after it becomes dot", async ({ page }) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await setOrbitComposer(page, false);
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const binding = window.__codexhostRendererBindingProbeV1;
    if (!binding) throw new Error("Missing fixture binding");
    const unavailable = async () => {
      throw new Error("Unused fixture method");
    };
    const client = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "inspectThread")
            return async () => {
              await new Promise<void>((resolve) => {
                window.addEventListener("fixture:finish-ownership", () => resolve(), {
                  once: true,
                });
              });
              throw new Error("Cloud rooms are not Host Threads");
            };
          if (key === "currentHostId" || key === "clientForHost" || key === "knownHostIds")
            return undefined;
          if (typeof key === "string" && key.startsWith("subscribe")) return () => () => undefined;
          return unavailable;
        },
      },
    );
    binding.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      client as never,
    );
  });
  await expect(page.locator('button[type="submit"]')).toBeDisabled();
  await setOrbitComposer(page, true);
  // Complete the old request before cleanup. It must not render a new blocker.
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-ownership")));
  expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
  await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "false"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator('button[type="submit"]')).toBeEnabled();
});

test("an external draft root reused after dot follows the new native draft preference", async ({
  page,
}) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  const setDraft = async (id: string, agent: string) =>
    page.locator('[role="textbox"]').evaluate(
      (editor, input) => {
        const modelState = { get: () => ({ modelSettings: null, isManuallyChanged: false }) };
        Object.defineProperty(editor, "__reactFiber$dot", {
          configurable: true,
          value: {
            memoizedProps: { isOrbit: false },
            updateQueue: {
              memoCache: {
                data: [[{}, {}, input.id, modelState, undefined, modelState, modelState]],
              },
            },
            return: null,
          },
        });
        localStorage.setItem(
          "codexhost.new-thread-preference.v1",
          JSON.stringify({ version: 1, lastAgent: input.agent, externalByAgent: {} }),
        );
      },
      { id, agent },
    );
  await setDraft("client-new-thread:external", "pi");
  await page.addScriptTag({ content: browserBundle });
  const selection = () =>
    page.evaluate(() => window.__codexhostRendererBindingProbeV1?.status().selections[0]);
  expect(await selection()).toMatchObject({ agent: "pi", phase: "draft" });
  const oldId = (await selection())?.composerId;
  // Preferences are Host-scoped. Give the fixture a real local Host context
  // rather than treating a missing request bridge as the local Host.
  await page.evaluate(() => {
    const unavailable = async () => {
      throw new Error("Unused fixture method");
    };
    const client = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "currentHostId" || key === "clientForHost" || key === "knownHostIds")
            return undefined;
          if (typeof key === "string" && key.startsWith("subscribe")) return () => () => undefined;
          return unavailable;
        },
      },
    );
    Object.defineProperty(window, "fixturePreferenceClient", { configurable: true, value: client });
    window.__codexhostRendererBindingProbeV1?.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      () => true,
      client as never,
    );
  });
  expect(await nativeSubmitResults(page, true)).toEqual({ received: 3 });
  await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "false"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await setDraft("client-new-thread:native", "codex");
  await page.locator("form").evaluate((root) => root.removeAttribute("aria-hidden"));
  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
  expect(await selection()).toMatchObject({ agent: "codex", phase: "draft" });
  expect((await selection())?.composerId).not.toBe(oldId);
  // The production binding must apply native Codex, not its previous Pi route.
  const applied = await page.evaluate(() => {
    let route: string | null = null;
    window.__codexhostRendererBindingProbeV1?.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      (agent) => {
        route = agent;
        return true;
      },
      Reflect.get(window, "fixturePreferenceClient"),
    );
    return route;
  });
  expect(applied).toBe("codex");
});

for (const outcome of ["success", "failure"] as const) {
  for (const recoveredKind of ["codex", "orbit", "detached"] as const) {
    test(`ownership settling with ${outcome} while unknown recovers as ${recoveredKind}`, async ({
      page,
    }) => {
      await page.setContent(
        '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
      );
      await setOrbitComposer(page, false);
      await page.addScriptTag({ content: browserBundle });
      await page.evaluate((firstOutcome) => {
        const binding = window.__codexhostRendererBindingProbeV1;
        if (!binding) throw new Error("Missing fixture binding");
        let calls = 0;
        let released = false;
        Object.defineProperty(window, "fixtureOwnershipCalls", {
          configurable: true,
          get: () => calls,
        });
        const unavailable = async () => {
          throw new Error("Unused fixture method");
        };
        const client = new Proxy(
          {},
          {
            get(_target, key) {
              if (key === "inspectThread")
                return async () => {
                  calls += 1;
                  if (!released) {
                    await new Promise<void>((resolve) =>
                      window.addEventListener(
                        "fixture:finish-ownership",
                        () => {
                          released = true;
                          resolve();
                        },
                        { once: true },
                      ),
                    );
                    if (firstOutcome === "failure") throw new Error("Transient inspection failure");
                  }
                  return { owner: "codex", locked: true };
                };
              if (key === "currentHostId" || key === "clientForHost" || key === "knownHostIds")
                return undefined;
              if (typeof key === "string" && key.startsWith("subscribe"))
                return () => () => undefined;
              return unavailable;
            },
          },
        );
        binding.setAdapter(
          { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
          undefined,
          undefined,
          client as never,
        );
      }, outcome);
      await expect(page.locator('button[type="submit"]')).toBeDisabled();
      await page.locator('[role="textbox"]').evaluate((editor) => {
        const fiber: { return: unknown } = { return: null };
        fiber.return = fiber;
        Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });
        window.dispatchEvent(new Event("fixture:finish-ownership"));
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const calls = () => page.evaluate(() => Reflect.get(window, "fixtureOwnershipCalls"));
      const initialCalls = await calls();
      expect(initialCalls).toBeGreaterThan(0);
      await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
      // Unknown must not derive a target even when a target-refresh scan runs.
      await page.locator("form").evaluate((root) => {
        const marker = document.createElement("span");
        root.append(marker);
        marker.remove();
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      expect(await calls()).toBe(initialCalls);
      if (recoveredKind === "detached") {
        await page.locator("form").evaluate((root) => root.remove());
      } else {
        await setOrbitComposer(page, recoveredKind === "orbit");
        await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "false"));
      }
      if (recoveredKind === "codex") {
        await expect.poll(calls).toBe(initialCalls + 1);
        await expect(page.locator('button[type="submit"]')).toBeEnabled();
        expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
        await page.locator("form").evaluate((root) => root.setAttribute("aria-hidden", "true"));
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        expect(await calls()).toBe(initialCalls + 1);
      } else {
        await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
        expect(await calls()).toBe(initialCalls);
        if (recoveredKind === "orbit") {
          await expect(page.locator('button[type="submit"]')).toBeEnabled();
          expect(await nativeSubmitResults(page)).toEqual({ received: 3 });
        }
      }
    });
  }
}

test("an external draft catalog settling while unknown is reloaded after recovery", async ({
  page,
}) => {
  await page.setContent(
    '<form data-codex-composer-root><div contenteditable="true" role="textbox">draft</div><button type="submit" aria-label="Send">Send</button></form>',
  );
  await page.locator('[role="textbox"]').evaluate((editor) => {
    const modelState = {
      get: () => ({ modelSettings: null, isManuallyChanged: false }),
      set: () => undefined,
    };
    const fiber = {
      memoizedProps: { isOrbit: false },
      updateQueue: {
        memoCache: {
          data: [
            [
              {},
              {},
              "client-new-thread:catalog-recovery",
              modelState,
              undefined,
              modelState,
              modelState,
            ],
          ],
        },
      },
      return: null,
    };
    Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });
    Object.defineProperty(window, "fixtureDraftFiber", { configurable: true, value: fiber });
    localStorage.setItem(
      "codexhost.new-thread-preference.v1",
      JSON.stringify({ version: 1, lastAgent: "pi", externalByAgent: {} }),
    );
  });
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    let calls = 0;
    let released = false;
    Object.defineProperty(window, "fixtureCatalogCalls", { configurable: true, get: () => calls });
    const unavailable = async () => {
      throw new Error("Unused fixture method");
    };
    const client = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "inspectHarness")
            return async (_input: unknown, options?: { priority?: string }) => {
              if (options?.priority !== "background") {
                calls += 1;
                if (!released)
                  await new Promise<void>((resolve) =>
                    window.addEventListener(
                      "fixture:finish-catalog",
                      () => {
                        released = true;
                        resolve();
                      },
                      { once: true },
                    ),
                  );
              }
              return {
                status: "ready",
                catalog: {
                  models: [{ ref: { id: "fixture-model" }, label: "Recovered Model" }],
                  defaultModel: { id: "fixture-model" },
                  thinkingOptions: [],
                },
                capabilities: {
                  configuration: {
                    selectModel: false,
                    selectThinkingOption: false,
                    selectPermissionMode: false,
                    permissionModeScope: "live",
                  },
                  history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
                },
              };
            };
          if (key === "currentHostId" || key === "clientForHost" || key === "knownHostIds")
            return undefined;
          if (typeof key === "string" && key.startsWith("subscribe")) return () => () => undefined;
          return unavailable;
        },
      },
    );
    window.__codexhostRendererBindingProbeV1?.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      () => true,
      client as never,
    );
  });
  const calls = () => page.evaluate(() => Reflect.get(window, "fixtureCatalogCalls"));
  await expect.poll(calls).toBeGreaterThan(0);
  await page.locator('[role="textbox"]').evaluate((editor) => {
    const fiber: { return: unknown } = { return: null };
    fiber.return = fiber;
    Object.defineProperty(editor, "__reactFiber$dot", { configurable: true, value: fiber });
    window.dispatchEvent(new Event("fixture:finish-catalog"));
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const initialCalls = await calls();
  await page.locator('[role="textbox"]').evaluate((editor) => {
    Object.defineProperty(editor, "__reactFiber$dot", {
      configurable: true,
      value: Reflect.get(window, "fixtureDraftFiber"),
    });
    editor.closest("form")?.setAttribute("aria-hidden", "false");
  });
  await expect.poll(calls).toBe(initialCalls + 1);
  await expect(page.locator("[data-codexhost-model-control] > button")).toContainText("No models");
});

test("ordinary Chat composers remain untouched", async ({ page }) => {
  await installChatComposer(page, browserBundle);

  await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-model-control]")).toHaveCount(0);
  await expect(page.locator("[data-codexhost-permission-mode-control]")).toHaveCount(0);
  await expect(page.locator("[data-chat-composer] button[type=submit]")).toBeEnabled();

  expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
});

for (const inline of [false, true]) {
  test(`a composer stops affecting input when its marker is removed (inline: ${inline})`, async ({
    page,
  }) => {
    await page.setContent(`
    <!doctype html>
    <body>
      ${inline ? '<section data-local-conversation-item-target-ids="item-1">' : ""}
      <form data-codex-composer-root data-mode="work">
        <div contenteditable="true" role="textbox">draft</div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
      ${inline ? "</section>" : ""}
    </body>
  `);
    await page.addScriptTag({ content: browserBundle });
    await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);

    await page.locator("[data-mode=work]").evaluate((composer) => {
      composer.removeAttribute("data-codex-composer-root");
      composer.setAttribute("data-chat-composer", "true");
      composer.setAttribute("data-mode", "chat");
    });

    await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(0);
    await expect(page.locator("[data-mode=chat] button[type=submit]")).toBeEnabled();
    expect(await dispatchInputIntents(page)).toEqual(unmodifiedInputResults);
  });
}
