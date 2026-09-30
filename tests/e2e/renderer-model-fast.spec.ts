import { expect, test, type Page } from "@playwright/test";
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
    let visible = true;
    let locale = "zh-CN";
    const render = () => renderRendererModelPicker(control, view, visible, "pi", locale);
    const control = mountRendererModelPicker("fast-test", (id) => {
      view = { ...view, selected: { id } };
      render();
    }, () => {});
    document.body.append(control.root);
    render();
    const actions = document.createElement("div");
    actions.style.cssText = "position:fixed;top:12px;left:12px;display:flex;gap:8px";
    for (const [label, action] of [
      ["Hide picker", () => { visible = false; render(); }],
      ["Disable picker", () => { view = { ...view, status: "selecting" }; render(); }],
      ["Dispose picker", () => control.dispose()],
      ["English", () => { locale = "en"; render(); }],
    ]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", action);
      actions.append(button);
    }
    document.body.append(actions);
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

async function mountFastFixture(page: Page, theme = "dark") {
  await page.route("http://fast.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><style>
    html { color-scheme:${theme} }
    body { font:13px system-ui; margin:0; height:100vh; display:flex; align-items:flex-end; justify-content:center; background:light-dark(#fafafa,#242424); color:light-dark(#222,#fff) }
    [data-codexhost-model-control] { margin-bottom:40px; padding:8px; background:light-dark(white,#343434); border-radius:18px }
    [popover] { background:white; box-shadow:0 2px 15px #ddd }
  </style></head><body></body></html>`,
    }),
  );
  await page.goto("http://fast.test/");
  await page.addScriptTag({ content: bundle });
}

test("Fast lightning is per selected model, independent from Thinking and the Model menu", async ({
  page,
}) => {
  await mountFastFixture(page);
  const tooltip = page.getByRole("tooltip", { includeHidden: true });
  const root = page.locator('[data-codexhost-model-control="fast-test"]');
  const trigger = root.locator('button[aria-haspopup="menu"]');
  const fast = root.locator("[data-codexhost-fast-toggle]");
  const mainMenu = page.getByRole("menu", { name: "Model and Thinking", exact: true });
  const modelMenu = page.getByRole("menu", { name: "Model", exact: true });
  await expect(fast).toBeVisible();
  await expect(root.locator(":scope > button").first()).toHaveAttribute(
    "data-codexhost-fast-toggle",
    "true",
  );
  const fastBounds = await fast.boundingBox();
  const triggerBounds = await trigger.boundingBox();
  expect(fastBounds).not.toBeNull();
  expect(triggerBounds).not.toBeNull();
  expect(fastBounds!.x + fastBounds!.width).toBeLessThanOrEqual(triggerBounds!.x);
  await expect(trigger).toHaveCSS("padding-left", "2px");
  await expect(fast).toHaveCSS("color", "rgb(143, 143, 143)");
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await expect(fast.locator("svg")).toHaveAttribute("viewBox", "0 0 24 24");
  await expect(fast.locator("svg")).toHaveCSS("width", "14px");
  await expect(fast.locator("svg")).toHaveCSS("height", "14px");
  await expect(fast.locator("path")).toHaveAttribute("fill", "none");
  await expect(fast.locator("path")).toHaveAttribute("stroke", "currentColor");
  await expect(trigger).toContainText("c / supportedHigh");
  const offHint = "Fast 已关闭 · 点击开启";
  const onHint = "Fast 已开启 · 点击关闭";
  await expect(fast).not.toHaveAttribute("title");
  await expect(tooltip).toBeHidden();
  await expect(fast).toHaveAttribute("aria-label", "Fast");
  await expect(fast).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: "/tmp/codexhost-pi-fast-off.png" });
  await fast.hover();
  // No opening timer: visible as soon as the pointerenter has been processed.
  expect(await tooltip.isVisible()).toBe(true);
  await expect(tooltip).toContainText(offHint);
  await expect(tooltip).toContainText("Codex Fast 模式：优先处理请求，可能增加额度消耗。");
  await expect(fast).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id"))!);
  await expect(fast).toHaveCSS("cursor", "pointer");
  await expect(fast).toHaveCSS("background-color", "rgba(127, 127, 127, 0.08)");
  await page.screenshot({ path: "/tmp/codexhost-pi-fast-hover.png" });
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "true");
  await expect(tooltip).toContainText(onHint);
  await expect(fast).toHaveAccessibleDescription(/Fast 已开启 · 点击关闭/);
  await expect(fast.locator("path")).toHaveAttribute("fill", "currentColor");
  await expect(fast.locator("path")).toHaveAttribute("stroke", "none");
  await expect(fast).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(trigger).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(mainMenu).toBeHidden();
  await expect(modelMenu).toBeHidden();
  await expect(trigger).toContainText("High");
  await page.screenshot({ path: "/tmp/codexhost-pi-fast-on.png" });
  await root.screenshot({ path: "/tmp/codexhost-pi-fast-native-icon.png" });
  await fast.click();
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await expect(tooltip).toContainText(offHint);
  await trigger.hover();
  await expect(tooltip).toBeHidden();
  await expect(fast).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
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
  await expect(tooltip).toBeHidden();
  await expect(trigger).toHaveCSS("padding-left", "8px");
  await expect(trigger).toContainText("c / unsupportedHigh");
  await page.screenshot({ path: "/tmp/codexhost-pi-fast-unsupported.png" });
  await trigger.click();
  await page.locator("button[data-open-model-menu]").click();
  await modelMenu.locator('[data-model-id="normal"]').click();
  await expect(fast).toHaveAttribute("aria-pressed", "false");
  await expect(root.locator(":scope > button").first()).toHaveAttribute(
    "data-codexhost-fast-toggle",
    "true",
  );
  await fast.focus();
  await page.keyboard.press("Space");
  await expect(fast).toHaveAttribute("aria-pressed", "true");
});

for (const theme of ["dark", "light"]) {
  test(`Fast help is hoverable, keyboard accessible and viewport-safe in ${theme} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 500 });
    await mountFastFixture(page, theme);
    const fast = page.locator("[data-codexhost-fast-toggle]");
    const tooltip = page.getByRole("tooltip", { includeHidden: true });
    await fast.hover();
    expect(await tooltip.isVisible()).toBe(true);
    const panel = await tooltip.boundingBox();
    const anchor = await fast.boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(12);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(348);
    expect(panel!.y).toBeGreaterThanOrEqual(12);
    expect(panel!.y + panel!.height).toBeLessThan(anchor!.y);
    await tooltip.hover();
    // Exercise the 140ms leave grace period while the pointer rests on the card.
    await page.waitForTimeout(200);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveCSS(
      "box-shadow",
      theme === "dark"
        ? "rgba(0, 0, 0, 0.42) 0px 10px 24px 0px, rgba(0, 0, 0, 0.28) 0px 2px 8px 0px"
        : "rgba(15, 23, 42, 0.12) 0px 10px 24px 0px, rgba(15, 23, 42, 0.06) 0px 2px 8px 0px",
    );
    await page.screenshot({ path: `/tmp/codexhost-fast-tooltip-${theme}.png` });
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await fast.hover();
    expect(await tooltip.isVisible()).toBe(true);
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(tooltip).toBeHidden();
    await fast.focus();
    expect(await tooltip.isVisible()).toBe(true);
    await expect(tooltip).toContainText("Fast is off · Click to enable");
    await expect(tooltip).toContainText("may increase usage");
    await page.screenshot({ path: `/tmp/codexhost-fast-tooltip-${theme}-focus.png` });
    await page.keyboard.press("Space");
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await expect(tooltip).toContainText("Fast is on · Click to disable");
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
  });
}

for (const action of ["Hide picker", "Disable picker", "Dispose picker"]) {
  test(`Fast help is cleaned up on ${action}`, async ({ page }) => {
    await mountFastFixture(page);
    const fast = page.locator("[data-codexhost-fast-toggle]");
    const tooltip = page.getByRole("tooltip", { includeHidden: true });
    await fast.hover();
    await expect(tooltip).toBeVisible();
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(tooltip).toBeHidden();
    if (action === "Dispose picker") {
      await expect(tooltip).toHaveCount(0);
      await expect(fast).toHaveCount(0);
    } else if (action === "Disable picker") {
      await expect(fast).toBeDisabled();
      await fast.hover();
      await expect(tooltip).toBeHidden();
    } else {
      await expect(fast).toBeHidden();
    }
  });
}
