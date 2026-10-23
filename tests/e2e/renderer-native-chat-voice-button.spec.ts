import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installNativeChatVoiceHook } from "./packages/renderer-extension/src/renderer-native-chat-voice.ts";
      const app = { id: Symbol(), __scopeBrand: "AppScope" };
      const route = { id: Symbol(), __scopeBrand: "RouteScope" };
      const composerScope = { id: Symbol(), __scopeBrand: "ComposerScope" };
      const appNode = {};
      const routeNode = {};
      const conversationId = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
      const selection = { conversationId };
      const chain = new Map([[app.id, appNode], [route.id, routeNode]]);
      const composerChain = new Map([[app.id, appNode], [composerScope.id, {
        value: { kind: "chatgpt", chatGptSelectionContext: selection },
      }]]);
      const backend = {};
      const enabled = {};
      let runtime = false;
      const scope = { scope: route, node: routeNode, chain,
        get: (selector) => selector === enabled ? runtime : null,
        set: (selector, value) => { if (selector === enabled) runtime = value; },
      };
      const form = document.querySelector("form");
      form.__reactFiber$fixture = { return: {
        memoizedProps: { conversationId, composerSelectionContext: selection,
          isWorkConversation: false, isTemporaryChat: false, shouldBlockExternalEgress: false },
        memoizedState: { memoizedState: { current: scope }, next: null },
        dependencies: { firstContext: {
          context: { displayName: "AppScope" }, memoizedValue: chain, next: {
            context: { displayName: "ComposerScope" }, memoizedValue: composerChain, next: null,
          },
        } }, return: null,
      } };
      const initial = { B1n: backend, CDr: composerScope, MOr: route, aT: enabled,
        oT() {}, SPn: () => ({
          getState: () => ({ isVoiceModeActive: false }), subscribe: () => () => {},
        }),
      };
      const shared = { Qst: app, FBt: () => ({ createElement() {} }),
        PNt: () => ({ createRoot: () => ({ render() {}, unmount() {} }) }),
      };
      globalThis.__codexhostCpaLiveVoiceHookV1 = { enabled: true, desktopVersion: "26.1016.61520", auditedDesktopVersion: "26.1016.61520", auditedAppInitialAsset: "app-initial-c95ddb62696e.js" };
      globalThis.voiceStarts = 0;
      globalThis.voiceHook = installNativeChatVoiceHook({ importModule: async (url) =>
        url.includes("app-initial") ? initial : url.includes("app-shared") ? shared :
        url.includes("start-voice") ? { t() {}, n: async () => { globalThis.voiceStarts++; } } :
        { VoiceInstantConnectCacheController() {} },
      });
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "native-chat-voice-button-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});
const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Chat voice button fixture was not generated");

for (const dictate of [false, true]) {
  test(`places Chat Voice to the left of Send ${dictate ? "with" : "without"} Dictate`, async ({
    page,
  }) => {
    await page.route("http://codexhost.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8">
        <style>
          body { margin: 40px; background: #181818; color: white; }
          form { display: flex; align-items: center; gap: 8px; width: 640px; padding: 8px; border-radius: 24px; background: #303030; }
          [role=textbox] { flex: 1; }
          .actions { display: flex; align-items: center; gap: 8px; }
          .native-action { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-radius: 50%; }
        </style>
        <script type="application/json" src="app://-/assets/app-initial-c95ddb62696e.js"></script>
        <script type="application/json" src="app://-/assets/app-shared-2eda13eb7044.js"></script>
        <form data-chatgpt-composer>
          <button type="submit" hidden aria-label="Hidden submit">Hidden</button>
          <div contenteditable="true" role="textbox">Ask ChatGPT</div>
          <div class="actions">
            <button type="button">Instant</button>
            ${dictate ? '<button type="button" aria-label="Dictate" class="native-action">Mic</button>' : ""}
            <button type="submit" aria-label="Send" class="native-action">↑</button>
          </div>
        </form><output>0</output>`,
      }),
    );
    await page.route("http://codexhost.test/assets/**", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" }),
    );
    await page.goto("http://codexhost.test/");
    await page.evaluate(() => {
      const form = document.querySelector("form");
      const output = document.querySelector("output");
      if (!form || !output) throw new Error("Chat form fixture is missing");
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        output.textContent = "submitted";
      });
    });
    await page.addScriptTag({ content: browserBundle });
    const voice = page.getByRole("button", { name: "Start Voice", exact: true });
    await expect(voice).toHaveCount(1);
    const position = await voice.evaluate((button) => {
      const send = button.nextElementSibling;
      if (!send) throw new Error("Voice is not followed by Send");
      const a = button.getBoundingClientRect();
      const b = send.getBoundingClientRect();
      return {
        send: send.getAttribute("aria-label"),
        sameParent: button.parentElement === send.parentElement,
        gap: b.left - a.right,
        centerDelta: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)),
      };
    });
    expect(position.send).toBe("Send");
    expect(position.sameParent).toBe(true);
    expect(position.gap).toBeGreaterThanOrEqual(0);
    expect(position.gap).toBeLessThanOrEqual(8);
    expect(position.centerDelta).toBeLessThan(1);
    await page.screenshot({
      path: `.codexhost/update-impact/26.1016.61520/chat-voice-button-${dictate ? "with" : "without"}-dictate.png`,
    });
    await voice.click();
    await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, "voiceStarts"))).toBe(1);
    await expect(page.locator("output")).toHaveText("0");

    // Native draft updates can replace the action wrapper while retaining the form.
    await page.getByRole("button", { name: "Send", exact: true }).evaluate((send) => {
      const wrapper = document.createElement("span");
      wrapper.className = "actions";
      wrapper.append(send.cloneNode(true));
      send.replaceWith(wrapper);
    });
    await expect
      .poll(() => voice.evaluate((button) => button.nextElementSibling?.getAttribute("aria-label")))
      .toBe("Send");
    await expect(voice).toHaveCount(1);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("output")).toHaveText("submitted");

    // A streaming Stop action is not a Send insertion target.
    await page.getByRole("button", { name: "Send", exact: true }).evaluate((send) => {
      send.setAttribute("type", "button");
      send.setAttribute("aria-label", "Stop");
    });
    await expect(voice).toHaveCount(0);
    await page.getByRole("button", { name: "Stop", exact: true }).evaluate((stop) => {
      stop.setAttribute("type", "submit");
      stop.setAttribute("aria-label", "Send");
    });
    await expect(voice).toHaveCount(1);
    await page.evaluate(() => Reflect.get(globalThis, "voiceHook").dispose());
    await expect(voice).toHaveCount(0);
  });
}
