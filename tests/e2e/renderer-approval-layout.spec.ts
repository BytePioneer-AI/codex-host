import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererApprovalStyle } from "./packages/renderer-extension/src/renderer-approval-style.ts";
      window.removeApprovalStyle = installRendererApprovalStyle(document);
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
});

test("native approval actions stay together without changing their controls", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 800, height: 300 });
  // Native ApprovalRequestCard structure, including the spacer responsible for the split.
  await page.setContent(`<!doctype html><html><head><style>
    body { margin:24px; font:13px system-ui; color:#eee; background:#202020; color-scheme:dark; }
    [data-codex-approval-surface] { container:approval-card / inline-size; background:#303030; border-radius:16px; }
    header { padding:16px; } h3 { margin:8px 0 0; font-size:13px; }
    form { display:flex; align-items:center; gap:8px; padding:8px 16px 16px; }
    .ms-auto { margin-inline-start:auto; display:flex; align-items:center; gap:8px; min-width:0; }
    button { border:0; padding:8px 12px; border-radius:20px; background:#3b3b3b; color:inherit; font:inherit; }
    button[type=submit] { background:white; color:#222; }
    @container approval-card (max-width:448px) {
      form { flex-direction:column; align-items:stretch; }
      .ms-auto { margin-inline-start:0; width:100%; flex-direction:column; align-items:stretch; }
    }
  </style></head><body>
    <section data-codex-approval-surface>
      <header>Kiro CLI<h3>Write File</h3></header>
      <form>
        <button type=button id=always>始终允许</button>
        <div class=ms-auto><button type=button id=deny>拒绝 Esc</button><button type=submit id=once>允许一次</button></div>
      </form>
    </section>
    <form id=unrelated><button type=button>Unrelated</button><div class=ms-auto>Unrelated</div></form>
  </body></html>`);
  await page.evaluate(() => {
    Reflect.set(window, "clicks", []);
    for (const button of document.querySelectorAll("button[id]")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        Reflect.get(window, "clicks").push(button.id);
      });
    }
  });
  const bundle = outputFiles[0]?.text;
  if (!bundle) throw new Error("Missing approval style bundle");
  await page.addScriptTag({ content: bundle });
  const always = page.locator("#always");
  const deny = page.locator("#deny");
  const once = page.locator("#once");
  const boxes = await Promise.all([always.boundingBox(), deny.boundingBox(), once.boundingBox()]);
  const [a, d, o] = boxes;
  if (!a || !d || !o) throw new Error("Approval controls missing");
  expect(d.x - a.x - a.width).toBeCloseTo(8);
  expect(o.x - d.x - d.width).toBeCloseTo(8);
  expect(a.y).toBeCloseTo(d.y);
  expect(d.y).toBeCloseTo(o.y);
  expect(o.x + o.width).toBeCloseTo(760);
  await page.locator("[data-codex-approval-surface]").screenshot({
    path: info.outputPath("approval-actions-grouped.png"),
  });
  await always.click();
  await deny.click();
  await once.click();
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toEqual([
    "always",
    "deny",
    "once",
  ]);
  expect(
    await page.locator("#unrelated > div").evaluate((el) => getComputedStyle(el).marginInlineStart),
  ).not.toBe("0px");
  await page.setViewportSize({ width: 375, height: 420 });
  for (const button of [always, deny, once]) {
    const box = await button.boundingBox();
    if (!box) throw new Error("Approval control missing at narrow viewport");
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
  await page.evaluate(() => Reflect.get(window, "removeApprovalStyle")());
  await expect(page.locator("style[data-codexhost-approval-style]")).toHaveCount(0);
});
