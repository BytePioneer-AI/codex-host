import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRecoveredTurnErrors } from "./packages/renderer-extension/src/renderer-transcript-dom.ts";
      const entries = [
        { hostId:"local", conversationId:"thread", turnId:"old", modelProvider:"codexhost", turn:{status:"failed",error:{message:"error"},params:{model:null}} },
        { hostId:"local", conversationId:"thread", turnId:"retry", turn:{status:"inProgress",error:null,params:{model:null}} },
        { hostId:"remote", conversationId:"thread", turnId:"old", turn:{status:"failed",error:{message:"error"},params:{model:"codexhost/antigravity-native"}} },
        { hostId:"local", conversationId:"native", turnId:"old", turn:{status:"failed",error:{message:"error"},params:{model:"gpt-6.1"}} },
        { hostId:"local", conversationId:"native", turnId:"retry", turn:{status:"completed",error:null,params:{model:"gpt-6.1"}} },
      ];
      function addNotice(entry, id) {
        const container = document.createElement("div");
        container.setAttribute("data-turn-key", entry.turnId);
        const aside = document.createElement("aside");
        aside.id = id; aside.setAttribute("aria-live","polite");
        aside.textContent = "Synthetic unsupported-location error";
        container.append(aside); document.body.append(container);
        const owner = { memoizedProps: { item:{type:"system-error",turnId:entry.turnId},hostId:entry.hostId,conversationId:entry.conversationId},return:{memoizedProps:{entries},return:null} };
        Object.defineProperty(aside,"__reactFiber$test",{value:{memoizedProps:{},return:owner}});
      }
      addNotice(entries[0], "old-error");
      addNotice(entries[1], "retry-error");
      addNotice(entries[2], "remote-error");
      addNotice(entries[3], "native-error");
      const dispose = installRecoveredTurnErrors(document);
      globalThis.recoveryFixture = {
        dispose,
        completeRetry() {
          entries[1].turn.status="completed";
          document.body.append(document.createElement("span"));
        },
        failAgain() {
          const entry={...entries[0],turnId:"new",turn:{...entries[0].turn}};
          entries.push(entry); addNotice(entry,"new-error");
        },
        remountOldError() { addNotice(entries[0],"hydrated-error"); },
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "recovered-errors-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});
const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Recovery fixture was not bundled");

test("old errors disappear after recovery, while current and unrelated errors remain visible", async ({
  page,
}) => {
  await page.setContent("<!doctype html><head></head><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await expect(page.locator("#old-error")).toBeVisible();
  await expect(page.locator("#retry-error")).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "recoveryFixture").completeRetry());
  await expect(page.locator("#old-error")).toBeHidden();
  await expect(page.locator("#retry-error")).toBeHidden();
  await expect(page.locator("#remote-error")).toBeVisible();
  await expect(page.locator("#native-error")).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "recoveryFixture").failAgain());
  await expect(page.locator("#new-error")).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "recoveryFixture").remountOldError());
  await expect(page.locator("#hydrated-error")).toBeHidden();
  await page.evaluate(() => Reflect.get(globalThis, "recoveryFixture").dispose());
  await expect(page.locator("#old-error")).toBeVisible();
  await expect(page.locator("#retry-error")).toBeVisible();
  await expect(page.locator("#hydrated-error")).toBeVisible();
});
