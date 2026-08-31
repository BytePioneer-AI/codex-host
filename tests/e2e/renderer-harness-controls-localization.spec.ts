import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { harnessPermissionModeCatalogSchema } from "@codexhost/shared-contracts";
      import { mountRendererHarnessCommandControl } from "./packages/renderer-extension/src/renderer-harness-command-control.ts";
      import { mountRendererPermissionModePicker, renderRendererPermissionModePicker } from "./packages/renderer-extension/src/renderer-permission-mode-picker.ts";

      globalThis.setupHarnessControlsChinese = () => {
        const toolbar = document.createElement("div");
        document.body.append(toolbar);
        const commands = mountRendererHarnessCommandControl(toolbar, null, () => {}, "zh-CN");
        commands.setCommands([{
          id: "omp.compact",
          invocation: "/compact",
          label: "Compact context",
          description: "Compact the current conversation context",
          argumentMode: "text",
        }]);

        const permissions = mountRendererPermissionModePicker("permissions", () => {}, "zh-CN");
        document.body.append(permissions.root);
        const catalog = harnessPermissionModeCatalogSchema.parse({
          modes: [
            {
              id: "always-ask",
              label: "Always ask",
              description: "Automatically allow reads and ask before write or execution actions.",
            },
            {
              id: "write",
              label: "Write",
              description: "Automatically allow reads and writes; ask before execution actions.",
            },
            {
              id: "yolo",
              label: "Full access",
              description: "Run all tool actions without approval prompts.",
              dangerous: true,
            },
          ],
          defaultModeId: "yolo",
        });
        renderRendererPermissionModePicker(permissions, {
          status: "ready",
          catalog,
          selected: catalog.defaultModeId,
        }, true, "zh-CN");
      };

      globalThis.setupPermissionModePickerZoomed = () => {
        document.documentElement.style.setProperty("--codex-window-zoom", "1.6");

        const shell = document.createElement("div");
        shell.style.position = "fixed";
        shell.style.inset = "0";
        shell.style.display = "flex";
        shell.style.alignItems = "flex-end";
        shell.style.justifyContent = "center";
        shell.style.boxSizing = "border-box";
        shell.style.paddingBottom = "60px";
        shell.style.width = "calc(100vw / var(--codex-window-zoom))";
        shell.style.height = "calc(100vh / var(--codex-window-zoom))";
        shell.style.zoom = "var(--codex-window-zoom)";

        const permissions = mountRendererPermissionModePicker("zoomed-permissions", () => {});
        const catalog = harnessPermissionModeCatalogSchema.parse({
          modes: [
            { id: "default", label: "Default" },
            { id: "full-access", label: "Full access", dangerous: true },
          ],
          defaultModeId: "default",
        });
        renderRendererPermissionModePicker(permissions, {
          status: "ready",
          catalog,
          selected: catalog.defaultModeId,
        }, true);
        shell.append(permissions.root);
        document.body.append(shell);
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-harness-controls-localization-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Harness controls bundle was not generated");

test("localizes shared Harness command and Permission Mode controls in Chinese", async ({
  page,
}) => {
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupHarnessControlsChinese");
    if (typeof setup !== "function") throw new Error("Harness controls setup is unavailable");
    setup();
  });

  const commandTrigger = page.locator("[data-codexhost-harness-command-control] button");
  await expect(commandTrigger).toHaveAttribute("aria-label", "Harness 命令");
  await commandTrigger.hover();
  const commandMenu = page.locator("[data-codexhost-harness-command-menu]");
  await expect(commandMenu).toBeVisible();
  await expect(commandMenu).toContainText("命令");
  await expect(commandMenu).toContainText("压缩当前对话上下文");
  await expect(commandMenu).toContainText("文本");
  await page.mouse.move(700, 700);
  await expect(commandMenu).toBeHidden();

  const permissionTrigger = page.locator("[data-codexhost-permission-mode-control] > button");
  await expect(permissionTrigger).toContainText("完全访问");
  await permissionTrigger.click();
  const permissionMenu = page.locator('[role="menu"][aria-label="权限模式"]');
  await expect(permissionMenu).toBeVisible();
  await expect(permissionMenu).toContainText("始终询问");
  await expect(permissionMenu).toContainText("自动允许读取；写入或执行操作前询问。");
  await expect(permissionMenu).toContainText("写入");
  await expect(permissionMenu).toContainText("完全访问");
  await expect(permissionMenu).toContainText("无需批准提示即可运行所有工具操作。");
});

test("keeps the Permission Mode menu anchored inside the Codex window zoom", async ({ page }) => {
  await page.setViewportSize({ width: 1_920, height: 1_440 });
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupPermissionModePickerZoomed");
    if (typeof setup !== "function") throw new Error("Permission Mode picker setup is unavailable");
    setup();
  });

  const trigger = page.locator(
    '[data-codexhost-permission-mode-control="zoomed-permissions"] > button',
  );
  const menu = page.locator("#zoomed-permissions-permission-mode-menu");
  await trigger.click();
  await expect(menu).toBeVisible();

  const [triggerBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
  if (!triggerBox || !menuBox) throw new Error("Permission Mode picker geometry is unavailable");

  expect(menuBox.x).toBeCloseTo(triggerBox.x, 0);
  expect(menuBox.width).toBeCloseTo(320 * 1.6, 0);
  expect(triggerBox.y - (menuBox.y + menuBox.height)).toBeCloseTo(6 * 1.6, 0);
});
