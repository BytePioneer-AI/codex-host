import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRendererCodexUsageGate } from "./packages/renderer-extension/src/renderer-codex-usage-gate.ts";

      const auth = { read: () => ({ authMethod: "chatgpt" }) };
      const usage = { read: () => ({ data: { rate_limit: { allowed: false } } }) };
      const reserve = { read: () => ({ active: false, hardBlocked: false }) };
      const accountGate = { read: get => get(auth).authMethod === "chatgpt" &&
        !get(reserve).active && get(usage).data.rate_limit.allowed === false };
      const reserveGate = { read: get => get(reserve).hardBlocked };
      const store = {
        get: atom => atom.read(store.get),
        sub: () => () => {},
      };

      function composer(id) {
        const form = document.createElement("form");
        form.id = id;
        form.innerHTML = '<aside>Codex usage limit reached</aside><div contenteditable="true" role="textbox">draft</div><button type="submit">Send</button><output>0</output>';
        document.body.append(form);
        const editor = form.querySelector('[role="textbox"]');
        const send = form.querySelector("button");
        const banner = form.querySelector("aside");
        const output = form.querySelector("output");
        let childMounted = false;
        let submitted = 0;
        const subscriptions = [];
        const render = () => {
          send.disabled = !editor.textContent.trim() || subscriptions.some((entry, index) =>
            (index < 2 || childMounted) && entry.instance.getSnapshot());
        };
        const subscribe = atom => {
          const subscriber = {
            getSnapshot: () => store.get(atom),
            subscribe: listener => store.sub(atom, listener),
            createRender: () => undefined,
          };
          const instance = {
            value: subscriber.getSnapshot(),
            getSnapshot: () => subscriber.getSnapshot(),
          };
          const effect = {
            deps: [subscriber.subscribe],
            create: () => subscriber.subscribe(render),
          };
          const entry = { subscriber, instance, hooks: [
            { memoizedState: [subscriber, [store, atom]] },
            { queue: instance },
            { memoizedState: effect },
          ] };
          subscriptions.push(entry);
          return entry;
        };
        const link = entries => {
          const hooks = entries.flatMap(entry => entry.hooks);
          hooks.forEach((hook, index) => hook.next = hooks[index + 1] ?? null);
          return hooks[0];
        };
        const ownerHooks = link([subscribe(accountGate), subscribe(reserveGate)]);
        const childHooks = link([subscribe(accountGate)]);
        const rootState = { current: null };
        const child = { memoizedState: null, return: null };
        const bannerFiber = {
          memoizedProps: { banner: {}, rateLimitStatus: {}, sendBlocked: true },
          child: { stateNode: banner },
        };
        child.sibling = bannerFiber;
        const owner = {
          memoizedProps: { onLocalSubmitStart() {}, submitDisabled: true },
          memoizedState: ownerHooks, child, return: null,
        };
        const root = { stateNode: rootState, child: owner };
        owner.return = root;
        child.return = owner;
        rootState.current = root;
        Object.defineProperty(editor, "__reactFiber$usageGate", { value: child });
        editor.addEventListener("input", render);
        form.addEventListener("submit", event => {
          event.preventDefault();
          output.textContent = String(++submitted);
        });
        render();
        return {
          gate: createRendererCodexUsageGate(form),
          commitLateChild() {
            childMounted = true;
            const nextChild = { ...child, memoizedState: childHooks, alternate: child };
            const nextOwner = { ...owner, child: nextChild, alternate: owner };
            const nextRoot = { stateNode: rootState, child: nextOwner };
            owner.alternate = nextOwner;
            child.alternate = nextChild;
            nextOwner.return = nextRoot;
            nextChild.return = nextOwner;
            rootState.current = nextRoot;
            render();
          },
        };
      }
      const external = composer("external");
      composer("codex");
      globalThis.usageGateFixture = external;
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "renderer-codex-usage-gate-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});
const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Codex usage gate bundle was not generated");

test("external submission follows committed gates and restores the Codex banner", async ({
  page,
}) => {
  await page.clock.install();
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  const external = page.locator("#external");
  const codex = page.locator("#codex");
  await expect(external.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(external.locator("aside")).toBeVisible();

  expect(
    await page.evaluate(() => Reflect.get(globalThis, "usageGateFixture").gate.update(true)),
  ).toBe("bypassed");
  await expect(external.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(external.locator("aside")).toBeHidden();
  await expect(codex.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(codex.locator("aside")).toBeVisible();

  await page.evaluate(() => Reflect.get(globalThis, "usageGateFixture").commitLateChild());
  await expect(external.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.clock.fastForward(1000);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "usageGateFixture").gate.refresh()),
  ).toBe("bypassed");
  await external.getByRole("button", { name: "Send" }).click();
  await expect(external.locator("output")).toHaveText("1");
  await expect(codex.locator("output")).toHaveText("0");

  await external.getByRole("textbox").fill("");
  await expect(external.getByRole("button", { name: "Send" })).toBeDisabled();
  await external.getByRole("textbox").fill("another draft");
  await expect(external.getByRole("button", { name: "Send" })).toBeEnabled();
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "usageGateFixture").gate.update(false)),
  ).toBe("native");
  await expect(external.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(external.locator("aside")).toBeVisible();
});
