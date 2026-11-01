import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountLoadedSessionsTable } from "./packages/renderer-extension/src/settings/loaded-sessions-table.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";
      const state = globalThis.fixture = {calls: [], rows: [], unsupported: false};
      const client = createRendererModelClient([{sendRequest: async (method, params) => {
        state.calls.push({method, params});
        if (state.unsupported) throw {code: -32601};
        return state.rows;
      }}]);
      const controller = new AbortController();
      const dispose = mountLoadedSessionsTable({content: document.body, signal: controller.signal}, rendererSettingsMessages("zh-CN"), () => client);
      state.dispose = () => { controller.abort(); dispose(); };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Missing session table fixture bundle");

test("read-only session table polls, shows state, handles unsupported Host and stops on disposal", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByText("暂无已加载的外部会话。")).toBeVisible();
  await page.evaluate(() => {
    Reflect.get(globalThis, "fixture").rows = [
      {
        threadId: "thread-1",
        title: "<script>Not HTML</script>",
        harnessId: "pi",
        state: "idle",
        reason: "timeout",
        inactiveMs: 120000,
      },
      {
        threadId: "thread-2",
        title: "Busy session",
        harnessId: "cursor-cli",
        state: "busy",
        reason: "background",
        inactiveMs: 60000,
      },
      {
        threadId: "thread-3",
        title: "Same age, earlier Harness",
        harnessId: "grok",
        state: "idle",
        reason: "timeout",
        inactiveMs: 120000,
      },
      {
        threadId: "thread-4",
        title: "Oldest session",
        harnessId: "pi",
        state: "idle",
        reason: "timeout",
        inactiveMs: 180000,
      },
    ];
  });
  await page.clock.fastForward(10_000);
  const table = page.getByRole("table", { name: "已加载会话" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.locator("tbody tr td:first-child")).toHaveText([
    "Oldest session",
    "Same age, earlier Harness",
    "<script>Not HTML</script>",
    "Busy session",
  ]);
  await expect(table).toContainText("<script>Not HTML</script>");
  await expect(table).toContainText("2 分钟");
  await expect(table).toContainText("尚未达到超时");
  await expect(table).toContainText("存在子任务、转向、命令或待处理交互");
  await expect(page.getByRole("button")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, "fixture").calls)).toEqual([
    { method: "codexhost/sessions/loaded/list", params: {} },
    { method: "codexhost/sessions/loaded/list", params: {} },
  ]);
  await page.evaluate(() => {
    Reflect.get(globalThis, "fixture").unsupported = true;
  });
  await page.clock.fastForward(10_000);
  await expect(page.getByText("本地 Host 不支持会话状态查询或当前不可用。")).toBeVisible();
  await expect(table).toBeHidden();
  const before = await page.evaluate(() => {
    const fixture = Reflect.get(globalThis, "fixture");
    fixture.dispose();
    return fixture.calls.length;
  });
  await page.clock.fastForward(30_000);
  expect(await page.evaluate(() => Reflect.get(globalThis, "fixture").calls.length)).toBe(before);
});
