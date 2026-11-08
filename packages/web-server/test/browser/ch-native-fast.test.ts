import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { nativeCodex } from "../support/native-codex.ts";
import { startServer } from "../support/server.ts";

for (const width of [390, 1280]) {
  it(
    `native Codex Fast displays confirmed selections and sends its opaque ref at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const host = nativeCodex(new FakeChHost());
      const normal = harnessModelRefSchema.parse({ id: "fixture-native-model" });
      const fast = harnessModelRefSchema.parse({ id: "fixture-native-priority" });
      const unsupported = harnessModelRefSchema.parse({ id: "fixture-native-no-priority" });
      const request = host.request.bind(host);
      let effectiveModel = normal;
      host.request = async <R>(method: string, params: Record<string, unknown>): Promise<R> => {
        if (method === "thread/start" || method === "codexhost/thread/model/select")
          effectiveModel = params.model as typeof normal;
        const reply = await request<R>(method, params);
        if (method === "codexhost/thread/inspect" || method === "codexhost/thread/model/select")
          Object.assign(reply as object, { effectiveModel, effectiveThinkingOptionId: "high" });
        if (method === "codexhost/harness/inspect" && params.harnessId === "codex") {
          Object.assign((reply as { catalog: object }).catalog, {
            models: [
              {
                ref: normal,
                fastModel: fast,
                label: "GPT-5.4",
                supportedThinkingOptionIds: ["high"],
              },
              { ref: unsupported, label: "No priority", supportedThinkingOptionIds: ["high"] },
            ],
            defaultModel: normal,
          });
        }
        return reply;
      };
      const debuggerServer = await startFakeChDebugger(host);
      t.after(() => debuggerServer.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--ch-cdp", debuggerServer.endpoint],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
        locale: "en-US",
      });
      await page.goto(url);
      const bolt = page.getByRole("button", { name: "Fast", exact: true });
      await bolt.waitFor();
      await page.getByRole("button", { name: /^Select model, current /u }).click();
      await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
      assert.equal(await bolt.getAttribute("aria-pressed"), "false");
      const selections: Record<string, unknown>[] = [];
      await page.route("**/api/session/selectModel", async (route) => {
        const body = route.request().postDataJSON() as {
          payload: { args: { request: Record<string, unknown> } };
        };
        selections.push(body.payload.args.request);
        await route.continue();
      });
      await bolt.click();
      await page.locator('[aria-label="Fast"][aria-pressed="true"]').waitFor();
      assert.equal(selections.at(-1)?.provider, "codex");
      assert.equal(selections.at(-1)?.model, fast.id);
      assert.equal(selections.at(-1)?.reasoningEffort, "high");
      await page
        .getByRole("button", {
          name: "Select model, current GPT-5.4, reasoning effort High",
          exact: true,
        })
        .waitFor();
      await bolt.click();
      await page.locator('[aria-label="Fast"][aria-pressed="false"]').waitFor();
      assert.equal(selections.at(-1)?.model, normal.id);
      await bolt.click();
      await page.locator('[aria-label="Fast"][aria-pressed="true"]').waitFor();
      await page.locator('[contenteditable="true"]').fill("Create a priority Thread");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("CH response: Create a priority Thread", { exact: true }).waitFor();
      assert.deepEqual(
        structuredClone(
          host.requests.find((entry) => entry.method === "thread/start")?.params.model,
        ),
        fast,
      );
      await page.locator('[aria-label="Fast"][aria-pressed="true"]').waitFor();
      await bolt.click();
      await page.locator('[aria-label="Fast"][aria-pressed="false"]').waitFor();
      assert.deepEqual(
        structuredClone(
          host.requests.filter((entry) => entry.method === "codexhost/thread/model/select").at(-1)
            ?.params.model,
        ),
        normal,
      );
      await bolt.click();
      await page.locator('[aria-label="Fast"][aria-pressed="true"]').waitFor();
      await page.reload();
      await page.locator('[aria-label="Fast"][aria-pressed="true"]').waitFor();
      // A separate draft selecting a Model without priority must not offer the switch.
      const draft = await browser.newPage({ viewport: { width, height: 900 } });
      await draft.goto(url);
      await draft.getByRole("button", { name: /^Select model, current /u }).click();
      await draft
        .getByRole("menu", { name: "Thinking", exact: true })
        .getByRole("menuitem", { name: "GPT-5.4", exact: true })
        .click();
      await draft.getByRole("menuitemradio", { name: "No priority", exact: true }).click();
      await draft.getByRole("button", { name: "Fast", exact: true }).waitFor({ state: "detached" });
    },
  );
}
