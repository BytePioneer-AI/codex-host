import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererDesktopThreadRead } from "./packages/renderer-extension/src/renderer-desktop-thread-read.ts";
      const calls = [];
      const local = { hostId: "local", manager: { sendRequest: async (method, input) => {
        calls.push({ method, input });
        return { threadId: input.threadId, harnessId: "codex", status: "completed", turn: null,
          progress: [], result: { availability: "available", text: "Desktop-local answer" }, nextCursor: null };
      } } };
      const remote = { hostId: "remote", manager: { sendRequest: async (method, reply) => {
        globalThis.readReply = { method, reply, calls };
      } } };
      globalThis.disposeThreadRead = installRendererDesktopThreadRead(window, () => ({
        forHost: (id) => id === "local" ? local : id === "remote" ? remote : null,
      }));
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "desktop-thread-read-e2e.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
});

test("answers an actual window Host notification over the requesting connection", async ({
  page,
}) => {
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await page.evaluate(() =>
    window.postMessage(
      {
        type: "mcp-notification",
        hostId: "remote",
        method: "codexhost/thread/desktop-read",
        params: {
          requestId: "4f09746b-3342-4397-94c9-e546009bc3c3",
          input: { threadId: "target", view: "result" },
        },
      },
      "*",
    ),
  );
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "readReply")))
    .toMatchObject({
      method: "codexhost/thread/desktop-read/reply",
      reply: { result: { threadId: "target", result: { text: "Desktop-local answer" } } },
      calls: [
        {
          method: "codexhost/thread/delegation-read",
          input: { threadId: "target", view: "result" },
        },
      ],
    });
  await page.evaluate(() => {
    Reflect.get(globalThis, "disposeThreadRead")();
    Reflect.deleteProperty(globalThis, "readReply");
    window.postMessage(
      {
        type: "mcp-notification",
        hostId: "remote",
        method: "codexhost/thread/desktop-read",
        params: {
          requestId: "4f09746b-3342-4397-94c9-e546009bc3c3",
          input: { threadId: "target", view: "result" },
        },
      },
      "*",
    );
  });
  // Let postMessage delivery run after disposal.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(await page.evaluate(() => Reflect.get(globalThis, "readReply"))).toBeUndefined();
});
