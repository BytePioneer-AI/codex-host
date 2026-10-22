import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { runDesktopController } from "../../packages/desktop-control/src/production-controller.js";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { rememberVoiceProductExperience, wrapClientOwnedVoiceFetch } from "./packages/renderer-extension/src/renderer-client-owned-voice.ts";
      rememberVoiceProductExperience({ productExperience: "work" });
      globalThis.cspViolations = [];
      addEventListener("securitypolicyviolation", (event) => {
        globalThis.cspViolations.push(event.violatedDirective);
      });
      let reply;
      const bridge = {
        subscribe(type, listener) { reply = listener; return () => {}; },
        dispatchMessage(type, message) {
          queueMicrotask(() => reply({ hostId: "local", message: {
            id: message.request.id,
            result: { status: 201, body: "fixture-answer", headers: { "content-type": "application/sdp" } },
          } }));
        },
      };
      const client = { fetch() { throw new Error("Unexpected direct request"); } };
      wrapClientOwnedVoiceFetch(client, bridge, () => true, async () => new Error("gateway failure"));
      document.querySelector("button").addEventListener("click", async () => {
        try {
          const response = await client.fetch("/wham/realtime/calls?intent=quicksilver", {
            method: "POST",
            body: JSON.stringify({ sdp: "offer", session: { model: "gpt-live-1-codex" } }),
            headers: {
              "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "gpt-6.1-sol" }),
            },
          });
          document.querySelector("output").textContent = response.status + ":" + await response.text();
        } catch (error) {
          document.querySelector("output").textContent = error.message;
        }
      });
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "voice-csp-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});
const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Voice CSP fixture was not generated");

// Capture the actual overlay injection assembled by the production controller.
const abort = new AbortController();
let overlaySource = "";
await runDesktopController(
  {
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    rendererPath: "/fixture/production.js",
    attachmentPort: 43124,
    attachmentNonce: "0123456789abcdef0123456789abcdef",
  },
  abort.signal,
  {
    readRenderer: async () => browserBundle,
    install: async (options) => {
      overlaySource = options.overlayHookSource ?? "";
      abort.abort();
      throw new Error("Fixture captured; no Desktop connection required");
    },
    startAttachmentServer: async () => ({ close: async () => {} }),
    ready: () => {},
    sleep: async () => {},
    monitorIntervalMs: 1,
  },
);
if (!overlaySource) throw new Error("Controller did not assemble the voice overlay");

for (const injection of ["script", "debugger"] as const) {
  test(`validates a voice response under strict CSP after ${injection} injection`, async ({
    page,
  }) => {
    await page.route("https://codexhost.test/**", async (route) => {
      if (route.request().url().endsWith("/voice.js")) {
        await route.fulfill({ contentType: "text/javascript", body: overlaySource });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": "script-src 'self'" },
        body: `<!doctype html><button>Start voice</button><output></output>${
          injection === "script" ? '<script src="/voice.js"></script>' : ""
        }`,
      });
    });
    await page.goto("https://codexhost.test/");
    if (injection === "debugger") {
      const session = await page.context().newCDPSession(page);
      await session.send("Runtime.evaluate", { expression: overlaySource });
      await session.detach();
    }
    // A real DOM event runs validation in the page's CSP context, even when
    // schema construction happened in a debugger's privileged context.
    await page.getByRole("button", { name: "Start voice" }).click();
    await expect(page.locator("output")).toHaveText("201:fixture-answer");
    // Flush the queued securitypolicyviolation task before inspecting it.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(await page.evaluate(() => Reflect.get(globalThis, "cspViolations"))).toEqual([]);
  });
}
