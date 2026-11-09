import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (executablePath) test.use({ launchOptions: { executablePath } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBindingProbe } from './packages/renderer-extension/src/renderer-binding-probe.ts';
      import { composerButtonsWithin, sendButtonWithin } from './packages/renderer-extension/src/renderer-composer-dom.ts';
      Object.assign(window, {fixtureButtons: composerButtonsWithin, fixtureSend: sendButtonWithin});
      installRendererBindingProbe({enabledAgents:['codex','pi'],defaultAgent:'pi'});
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Missing native request isolation bundle");
const attributes = ["data-codex-composer-request", "data-codex-composer-request-navigation"];
const ownedControls = ["agent", "model", "permission-mode", "credits", "usage", "harness-command"]
  .map((name) => `[data-codexhost-${name}-control]`)
  .join(",");

test.beforeEach(async ({ page }) => {
  await page.route("http://localhost/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><section id="wrapper"><form id="composer" data-codex-composer-root><div id="surface"><div id="editor" contenteditable="true" role="textbox">keep this answer</div><button id="send" type="submit" aria-label="Send">Send</button></div></form></section>',
    }),
  );
  await page.goto("http://localhost/");
});

async function install(page: Page) {
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

// Mutation and events share one JS task: capture listeners must yield before the next scan.
async function nativeEvents(page: Page, marker?: { selector: string; attribute: string }) {
  return page.evaluate((marker) => {
    if (marker) {
      const target = document.querySelector(marker.selector);
      if (!target) throw new Error("Missing native request marker target");
      target.setAttribute(marker.attribute, "");
    }
    const editor = document.querySelector("#editor");
    const form = document.querySelector("#composer");
    const send = document.querySelector("#send");
    if (!editor || !form || !send) throw new Error("Missing native request fixture controls");
    const received: string[] = [];
    for (const key of ["Enter", "Backspace", "#"]) {
      editor.addEventListener(
        "keydown",
        (event) => {
          received.push(key);
          event.preventDefault();
        },
        { once: true },
      );
      editor.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    for (const [target, event] of [
      [
        editor,
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: "x",
          bubbles: true,
          cancelable: true,
        }),
      ],
      [form, new Event("submit", { bubbles: true, cancelable: true })],
      [send, new MouseEvent("click", { bubbles: true, cancelable: true })],
    ] as const) {
      target.addEventListener(
        event.type,
        (receivedEvent) => {
          received.push(event.type);
          receivedEvent.preventDefault();
        },
        { once: true },
      );
      target.dispatchEvent(event);
    }
    return received;
  }, marker);
}
const expectedEvents = ["Enter", "Backspace", "#", "beforeinput", "submit", "click"];

for (const attribute of attributes) {
  for (const selector of ["#wrapper", "#composer", "#surface"]) {
    test(`${attribute} on ${selector} is never mounted or intercepted`, async ({ page }) => {
      await page
        .locator(selector)
        .evaluate((element, name) => element.setAttribute(name, ""), attribute);
      await install(page);
      await expect(page.locator(ownedControls)).toHaveCount(0);
      await expect(page.locator("#send")).toBeEnabled();
      expect(await nativeEvents(page)).toEqual(expectedEvents);
      const buttons = await page.evaluate(() => ({
        count: Reflect.get(window, "fixtureButtons")(document.querySelector("#composer")).length,
        send: Reflect.get(window, "fixtureSend")(document.querySelector("#composer")),
      }));
      expect(buttons).toEqual({ count: 0, send: null });
      await expect(page.locator("#editor")).toHaveText("keep this answer");
    });
  }

  test(`${attribute} suspends an already mounted root and restores chat after marker removal`, async ({
    page,
  }) => {
    await install(page);
    await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
    expect(await nativeEvents(page, { selector: "#surface", attribute })).toEqual(expectedEvents);
    await expect(page.locator(ownedControls)).toHaveCount(0);
    await expect(page.locator("#send")).toBeEnabled();
    await expect(page.locator("#editor")).toHaveText("keep this answer");
    await page
      .locator("#surface")
      .evaluate((element, name) => element.removeAttribute(name), attribute);
    await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
    await expect(page.locator("#editor")).toHaveText("keep this answer");
  });

  test(`${attribute} insertion/removal inside an editor triggers cleanup rather than being ignored as typing`, async ({
    page,
  }) => {
    await install(page);
    await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
    await page.locator("#editor").evaluate((editor, name) => {
      const request = document.createElement("div");
      request.id = "native-request";
      request.setAttribute(name, "");
      request.innerHTML =
        '<button id="accept" type="button">Allow once</button><button id="deny" type="button" disabled>Deny</button>';
      editor.append(request);
    }, attribute);
    await expect(page.locator(ownedControls)).toHaveCount(0);
    await expect(page.locator("#accept")).toBeEnabled();
    await expect(page.locator("#deny")).toBeDisabled();
    await page.locator("#native-request").evaluate((element) => element.remove());
    await expect(page.locator("[data-codexhost-agent-control]")).toHaveCount(1);
  });
}

test("native request isolation is scoped to its Composer, not other chats", async ({ page }) => {
  await page
    .locator("#surface")
    .evaluate((element) => element.setAttribute("data-codex-composer-request", ""));
  await page.evaluate(() => {
    const sibling = document.createElement("form");
    sibling.id = "other-chat";
    sibling.setAttribute("data-codex-composer-root", "");
    sibling.innerHTML = '<textarea>another draft</textarea><button type="submit">Send</button>';
    document.body.append(sibling);
  });
  await install(page);
  await expect(page.locator("#composer").locator(ownedControls)).toHaveCount(0);
  await expect(page.locator("#other-chat [data-codexhost-agent-control]")).toHaveCount(1);
  expect(await nativeEvents(page)).toEqual(expectedEvents);
});

test("late ownership failure cannot disable a native answer or remount chat controls", async ({
  page,
}) => {
  await page.locator("#editor").evaluate((editor) => {
    Object.defineProperty(editor, "__reactFiber$fixture", {
      value: {
        memoizedProps: { isOrbit: false, conversationId: "fixture-thread" },
        return: null,
      },
    });
  });
  await install(page);
  await page.evaluate(() => {
    const client = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "inspectThread")
            return async () => {
              await new Promise<void>((resolve) =>
                window.addEventListener("fixture:release", () => resolve(), { once: true }),
              );
              throw Error("Delayed ownership failure");
            };
          if (["currentHostId", "clientForHost", "knownHostIds"].includes(String(key)))
            return undefined;
          if (String(key).startsWith("subscribe")) return () => () => undefined;
          return async () => {
            throw Error("Unused fixture method");
          };
        },
      },
    );
    window.__codexhostRendererBindingProbeV1?.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      client as never,
    );
  });
  await expect(page.locator("#send")).toBeDisabled();
  expect(
    await nativeEvents(page, { selector: "#surface", attribute: "data-codex-composer-request" }),
  ).toEqual(expectedEvents);
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:release")));
  await expect(page.locator(ownedControls)).toHaveCount(0);
  await expect(page.locator("#send")).toBeEnabled();
  expect(await nativeEvents(page)).toEqual(expectedEvents);
});
