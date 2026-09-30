import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
    import { mountRendererModelPicker, renderRendererModelPicker } from "./packages/renderer-extension/src/renderer-model-picker.ts";
    const catalog = { models: [
      { ref: { id: "normal" }, fastModel: { id: "priority" }, label: "c / supported", supportedThinkingOptionIds: ["high"] },
      { ref: { id: "unsupported" }, label: "c / unsupported", supportedThinkingOptionIds: ["high"] }
    ], thinkingOptions: [{ id: "high", label: "High" }] };
    let view = { status: "ready", catalog, selected: { id: "normal" }, selectedThinkingOptionId: "high" };
    const control = mountRendererModelPicker("fast-test", (id) => {
      view = { ...view, selected: { id } };
      renderRendererModelPicker(control, view, true, "pi", "zh-CN");
    }, () => {});
    document.body.append(control.root);
    renderRendererModelPicker(control, view, true, "pi", "zh-CN");
  `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Fast picker bundle was not generated");

test("Fast lightning is per selected model, independent from Thinking and the Model menu", async ({
  page,
}) => {
  await page.route("http://fast.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><style>
    body { font:13px system-ui; margin:0; height:100vh; display:flex; align-items:flex-end; justify-content:center; background:#fafafa; color:#222 }
    [data-codexhost-model-control] { margin-bottom:40px; padding:8px; background:white; border-radius:18px; box-shadow:0 2px 15px #ddd }
    [popover] { background:white; box-shadow:0 2px 15px #ddd }
  </style></head><body></body></html>`,
    }),
  );
  await page.goto("http://fast.test/");
  await page.addScriptTag({ content: bundle });
  const root = page.locator('[data-codexhost-model-control="fast-test"]');
  const trigger = root.locator('button[aria-haspopup="menu"]');
  const fast = root.locator("[data-codexhost-fast-toggle]");
  const mainMenu = page.getByRole("menu", { name: "Model and Thinking", exact: true });
  const modelMenu = page.getByRole("menu", { name: "Model", exact: true });
  await expect(fast).toBeVisible();
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await expect(fast.locator("path")).toHaveAttribute("fill", "none");
  await expect(trigger).toContainText("c / supportedHigh");
  await page.screenshot({ path: "/tmp/codexhost-pi-fast-off.png" });
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "true");
  await expect(fast.locator("path")).toHaveAttribute("fill", "currentColor");
  await expect(fast).toHaveCSS("color", "rgb(245, 158, 11)");
  await expect(mainMenu).toBeHidden();
  await expect(modelMenu).toBeHidden();
  await expect(trigger).toContainText("High");
  await page.screenshot({ path: "/tmp/codexhost-pi-fast-on.png" });
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await fast.click();
  await trigger.click();
  await page.locator("button[data-open-model-menu]").click();
  await expect(modelMenu.locator("button[data-model-id]")).toHaveCount(2);
  await expect(modelMenu.locator('[data-model-id="normal"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await modelMenu.locator('[data-model-id="unsupported"]').click();
  await expect(fast).toHaveCount(0);
  await expect(trigger).toContainText("c / unsupportedHigh");
  await page.screenshot({ path: "/tmp/codexhost-pi-fast-unsupported.png" });
  await trigger.click();
  await page.locator("button[data-open-model-menu]").click();
  await modelMenu.locator('[data-model-id="normal"]').click();
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await fast.focus();
  await page.keyboard.press("Space");
  await expect(fast).toHaveAttribute("aria-pressed", "true");
});
