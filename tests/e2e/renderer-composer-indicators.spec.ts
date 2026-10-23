import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountComposerAgentControl, renderComposerAgentControl, disposeComposerAgentControl } from "./packages/renderer-extension/src/renderer-composer-dom.ts";
      const composer = document.querySelector("[data-codex-composer-root]");
      const nativePermission = document.querySelector("#permission");
      Object.defineProperty(nativePermission, "__reactFiber$test", { value: { memoizedProps: {
        "data-composer-navigation-target": "permissions", "aria-haspopup": "menu",
        showPermissionsModeDropdown: true, permissionsHostId: "local", permissionsCwdOverride: null,
      } } });
      const control = mountComposerAgentControl(composer, "cache", document.querySelector("#send"), ["codex", "pi"], () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
      const usage = { composerIndicators: [{ kind: "countdown", id: "cache", expiresAtUnix: Math.floor(Date.now() / 1000) + 48 * 60, label: { en: "Prompt cache", "zh-CN": "提示词缓存" } }] };
      globalThis.renderIndicators = (agent = "pi") => renderComposerAgentControl(control, { agent, phase: "draft" }, "ready", false, {}, { status: "idle" }, { status: "ready", catalog: { modes: [{ id: "default", label: "Default" }], defaultModeId: "default" }, selected: "default" }, usage, null, "zh-CN");
      globalThis.disposeIndicators = () => disposeComposerAgentControl(control);
      globalThis.renderIndicators();
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Composer indicators bundle was not generated");

test("places generic countdowns beside permissions, refreshes locally, yields space and excludes Codex", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-08-01T10:00:00Z") });
  await page.setContent(`<!doctype html><style>[hidden] { display:none !important; } button { flex-shrink:0; }</style>
    <div data-codex-composer-root style="width:800px"><textarea></textarea><div id="toolbar" style="display:flex;align-items:center;gap:4px;width:100%">
    <button id="permission" aria-haspopup="menu" data-composer-navigation-target="permissions">Permissions</button><button id="send" type="submit">Send</button>
    </div></div>`);
  await page.addScriptTag({ content: browserBundle });
  const indicator = page.locator("[data-codexhost-composer-indicators]");
  const permission = page.locator("[data-codexhost-permission-mode-control]");
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveText("48m");
  await expect(indicator.locator("span[title]")).toHaveAttribute(
    "title",
    "提示词缓存 · 剩余 48 分钟",
  );
  expect(await indicator.evaluate((root) => root.previousElementSibling?.id)).toBe("permission");
  await page.clock.runFor(60_000);
  await expect(indicator).toHaveText("47m");
  await page.locator("[data-codex-composer-root]").evaluate((root) => {
    (root as HTMLElement).style.width = "220px";
  });
  await expect(indicator).toBeHidden();
  await expect(permission).toBeVisible();
  await expect(page.locator("#send")).toBeVisible();
  await page.locator("[data-codex-composer-root]").evaluate((root) => {
    (root as HTMLElement).style.width = "800px";
  });
  await expect(indicator).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "renderIndicators")("codex"));
  await expect(indicator).toBeHidden();
  await page.evaluate(() => Reflect.get(globalThis, "renderIndicators")("pi"));
  await expect(indicator).toBeVisible();
  await page.clock.runFor(47 * 60_000);
  await expect(indicator).toBeHidden();
  await page.evaluate(() => Reflect.get(globalThis, "disposeIndicators")());
  await expect(indicator).toHaveCount(0);
});
