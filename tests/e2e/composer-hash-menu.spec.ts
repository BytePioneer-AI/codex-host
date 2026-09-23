import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import type { HarnessAdapter } from "../../packages/harness-adapter/src/index.js";
import { createHarnessAdapter as createCodeBuddyAdapter } from "../../packages/adapters/codebuddy/src/plugin.js";
import { createHarnessAdapter as createCursorAdapter } from "../../packages/adapters/cursor-cli/src/plugin.js";
import { createHarnessAdapter as createHermesAdapter } from "../../packages/adapters/hermes/src/plugin.js";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

// The `#` menu and the Composer command button, wired like the Renderer probe
// wires them: the button types `#`, the menu reads the button's catalog.
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererDelegationMention } from "./packages/renderer-extension/src/renderer-delegation-mention.ts";
      import { mountRendererHarnessCommandControl } from "./packages/renderer-extension/src/renderer-harness-command-control.ts";
      import { rendererHarnessCommandExecutesDirectly } from "./packages/renderer-extension/src/renderer-harness-command-claim.ts";
      import { rendererHarnessMessages, rendererLiveCommandsPendingNotice } from "./packages/renderer-extension/src/renderer-harness-localization.ts";

      globalThis.setupHashMenu = ({ commands, hasSession, locale, source }) => {
        const editor = document.createElement("div");
        editor.contentEditable = "true";
        editor.setAttribute("data-test-editor", "");
        const toolbar = document.createElement("div");
        document.body.append(editor, toolbar);
        let menu = null;
        const control = mountRendererHarnessCommandControl(toolbar, null, () => menu.openFor(editor), locale);
        control.setCommands(commands, hasSession, source);
        globalThis.setHasSession = (next) => control.setCommands(commands, next, source);
        menu = installRendererDelegationMention(document, {
          readTargets: () => [],
          isComposerEditor: (element) => element === editor,
          readLocale: () => locale,
          anchorForEditor: () => editor,
          readCommands: () => {
            const snapshot = control.snapshot();
            const pendingNotice =
              snapshot.source === "static" ? rendererLiveCommandsPendingNotice(locale, "Cursor CLI (Experimental)") : null;
            if (snapshot.commands.length === 0 && pendingNotice === null) return null;
            return {
              commands: snapshot.commands,
              pendingNotice,
              disabledReason: (command) =>
                !snapshot.hasSession && rendererHarnessCommandExecutesDirectly(command)
                  ? rendererHarnessMessages(locale).commandRequiresConversation
                  : null,
              select: (command) => { globalThis.selectedCommand = command.id; },
            };
          },
        });
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const bundleText = outputFiles[0]?.text;
if (!bundleText) throw new Error("Missing # menu bundle");
const bundle: string = bundleText;

async function setup(
  page: Page,
  options: {
    commands: unknown[];
    hasSession: boolean;
    locale: "en" | "zh-CN";
    source?: "live" | "static";
  },
): Promise<void> {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((input) => Reflect.get(globalThis, "setupHashMenu")(input), options);
}

const menu = (page: Page) => page.locator("[data-codexhost-delegation-mention-menu]");
const trigger = (page: Page) => page.locator("[data-codexhost-harness-command-control] > button");

for (const [name, create, count, directId] of [
  ["codebuddy", createCodeBuddyAdapter, 2, "codebuddy.cost"],
  ["hermes", createHermesAdapter, 5, "hermes.help"],
  ["cursor", createCursorAdapter, 1, "cursor.copy-request-id"],
] as const)
  for (const managedRemoteHost of [false, true])
    for (const hasSession of [false, true]) {
      test(`${name} catalog opens from the command button in the # menu (hasSession=${hasSession}, managedRemoteHost=${managedRemoteHost})`, async ({
        page,
      }) => {
        const adapter: HarnessAdapter = create({
          platform: "darwin",
          managedRemoteHost,
          environment: { PATH: "" },
        });
        try {
          // The same Adapter metadata the Host's command inspection RPC reads.
          const catalog = adapter.commandCatalog ?? { commands: [] };
          await setup(page, { commands: catalog.commands, hasSession, locale: "en" });
          await trigger(page).click();
          await expect(menu(page)).toBeVisible();
          await expect(page.locator("[data-test-editor]")).toHaveText("#");
          await expect(menu(page).locator("[data-command-id]")).toHaveCount(count);
          const direct = menu(page).locator(`[data-command-id="${directId}"]`);
          if (hasSession) {
            await direct.click();
            // Selection settles after the editor adopts the `#` range removal.
            await expect
              .poll(() => page.evaluate(() => Reflect.get(globalThis, "selectedCommand")))
              .toBe(directId);
            await expect(page.locator("[data-test-editor]")).toHaveText("");
          } else {
            await expect(
              menu(page).locator(`[aria-disabled="true"] [data-command-id="${directId}"]`),
            ).toBeVisible();
          }
        } finally {
          await adapter.close();
        }
      });
    }

test("the command button explains the # trigger and opens the menu", async ({ page }) => {
  await setup(page, {
    commands: [
      {
        id: "omp.compact",
        invocation: "/compact",
        label: "Compact context",
        description: "Compact the current conversation context",
        argumentMode: "text",
      },
    ],
    hasSession: false,
    locale: "zh-CN",
  });
  await expect(trigger(page)).toHaveAttribute("title", "输入 # 打开命令、技能和 Agent");
  await expect(trigger(page)).toHaveAttribute("aria-label", "输入 # 打开命令、技能和 Agent");
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
  // Compact runs directly, so it needs a Thread even though it accepts text.
  await expect(menu(page)).toContainText("请先开始对话，再执行此命令");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();

  await page.evaluate(() => Reflect.get(globalThis, "setHasSession")(true));
  await page.keyboard.press("Backspace");
  await page.keyboard.type("#");
  await expect(menu(page)).toContainText("压缩当前对话上下文");
});

test("the command button spaces # from a preceding word", async ({ page }) => {
  await setup(page, {
    commands: [{ id: "x.plan", invocation: "/plan", label: "Plan", argumentMode: "text" }],
    hasSession: true,
    locale: "en",
  });
  await page.locator("[data-test-editor]").click();
  await page.keyboard.type("hello");
  await trigger(page).click();
  await expect(page.locator("[data-test-editor]")).toHaveText("hello #");
  await expect(menu(page)).toBeVisible();
});

test("a draft without its workspace's live catalog explains when it loads", async ({ page }) => {
  await setup(page, { commands: [], hasSession: false, locale: "zh-CN", source: "static" });
  const notice = menu(page).locator("[data-codexhost-command-notice]");
  await trigger(page).click();
  await expect(notice).toHaveText("发送一条消息后，会加载 Cursor CLI 在当前项目的全部命令和技能");
  await expect(menu(page)).toContainText("命令");
  // A query matching nothing closes the menu instead of keeping only the hint.
  await page.keyboard.type("zzz");
  await expect(menu(page)).toBeHidden();
});

test("a live workspace catalog shows no loading hint", async ({ page }) => {
  await setup(page, {
    commands: [
      {
        id: "x.slash.review",
        invocation: "/review",
        label: "review",
        argumentMode: "text",
        kind: "skill",
      },
    ],
    hasSession: false,
    locale: "en",
    source: "live",
  });
  await trigger(page).click();
  await expect(menu(page).locator('[data-command-id="x.slash.review"]')).toBeVisible();
  await expect(menu(page).locator("[data-codexhost-command-notice]")).toHaveCount(0);
});
