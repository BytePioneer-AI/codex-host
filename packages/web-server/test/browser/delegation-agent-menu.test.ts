import assert from "node:assert/strict";
import { it } from "node:test";
import { discoveryBrowser } from "../support/discovery-browser.ts";

it(
  "inserts real Harness identities at the caret, supports multiple references/undo/copy, and submits only explicitly",
  { timeout: 60_000 },
  async (t) => {
    const { host, state, page, composer, plus, menu, open, attach, writeMethods } =
      await discoveryBrowser(t, 1280, true);
    await open();
    await composer.fill("Before After");
    await composer.press("Home");
    for (let i = 0; i < 7; i++) await composer.press("ArrowRight");
    await attach();
    const inspectCount = host.requests.filter(
      (r) => r.method === "codexhost/harness/inspect",
    ).length;
    state.failure = "Command catalog unavailable";
    await plus.click();
    await menu.getByRole("option", { name: /Retry native commands/ }).waitFor();
    const targets = menu.getByRole("option").filter({ hasText: /^(Codex|Twin)/ });
    assert.deepEqual(await targets.allTextContents(), ["Codexcodex-cli", "Twinfake", "Twinother"]);
    assert.equal(await menu.getByRole("option", { name: /Missing|Usage/ }).count(), 0);
    await menu.getByRole("option", { name: "Codex codex-cli", exact: true }).click();
    const chips = composer.locator('[data-composer-chip="codexhost-delegation"]');
    await chips.waitFor();
    assert.equal((await composer.innerText()).replace(/\s+/g, " "), "Before Codex After");
    assert.equal(writeMethods().length, 0);
    assert.equal(
      host.requests.filter((r) => r.method === "codexhost/harness/inspect").length,
      inspectCount,
    );
    await composer.press("ControlOrMeta+Z");
    assert.equal(await chips.count(), 0);
    assert.equal(await composer.innerText(), "Before After");
    await plus.click();
    await menu.getByRole("option", { name: "Twin fake", exact: true }).click();
    await composer.press("End");
    await plus.click();
    await menu.getByRole("option", { name: "Twin other", exact: true }).click();
    assert.equal(await chips.count(), 2);
    await composer.press("ControlOrMeta+A");
    await composer.press("ControlOrMeta+C");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(text, /Before \[@Twin\]\(subagent:\/\/codexhost\.fake\) After/);
    assert.match(text, /\[@Twin\]\(subagent:\/\/codexhost\.other\)/);
    assert.equal(writeMethods().length, 0);
    state.failure = "";
    await composer.press("End");
    await plus.click();
    await menu.getByRole("option", { name: /^Native skill\b/ }).click();
    assert.equal(await chips.count(), 2, "selecting a native command retains reference nodes");
    await composer.press("ControlOrMeta+Z");
    await composer.press("ControlOrMeta+A");
    await composer.press("ControlOrMeta+C");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    await page.getByText("kept.txt", { exact: true }).waitFor();
    await page.reload();
    await composer.waitFor();
    await chips.first().waitFor();
    assert.equal(await chips.count(), 2, "saved draft restores reference identities");
    await composer.click();
    await composer.press("ControlOrMeta+A");
    await composer.press("ControlOrMeta+C");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    // Browser-owned attachments are not persisted across a page reload.
    await attach();
    // Explicit send rejection and an applied-but-unacknowledged write retain the same carriers.
    const request = host.request.bind(host);
    let attempts = 0;
    let unknown = false;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method !== "turn/start") return request<T>(method, params);
      attempts++;
      assert.match(JSON.stringify(params.input), /subagent:\/\/codexhost\.fake/);
      assert.match(JSON.stringify(params.input), /subagent:\/\/codexhost\.other/);
      if (unknown) await request<T>(method, params);
      throw new Error(unknown ? "Delegation outcome unknown" : "Delegation refused");
    };
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText(/Delegation refused/).waitFor();
    assert.equal(await chips.count(), 2);
    await page.getByText("kept.txt", { exact: true }).waitFor();
    unknown = true;
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText(/Delegation outcome unknown/).waitFor();
    assert.equal(await chips.count(), 2);
    await page.waitForTimeout(150);
    assert.equal(attempts, 2, "no automatic resend or second delegation request");
    assert.equal(
      host.requests.some((r) => /delegate|watch|model\/select/.test(r.method)),
      false,
    );
  },
);

it(
  "searches real IDs, leaves bare mentions plain, and ignores targets removed by the existing catalog update",
  { timeout: 60_000 },
  async (t) => {
    const { host, page, composer, plus, menu, open, writeMethods } = await discoveryBrowser(
      t,
      1280,
      true,
    );
    await open();
    await composer.fill("Discuss Codex @Codex");
    await composer.press("Escape");
    assert.equal(await composer.locator("[data-composer-chip]").count(), 0);
    await composer.fill("/codex-cli");
    await menu.getByRole("option", { name: "Codex codex-cli", exact: true }).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await composer.locator('[data-composer-chip="codexhost-delegation"]').waitFor();
    assert.equal(writeMethods().length, 0);
    await composer.press("Backspace");
    await composer.press("Backspace");
    assert.equal(await composer.locator('[data-composer-chip="codexhost-delegation"]').count(), 0);
    // Model selector's catalog refresh supplies the change; discovery must make no extra inspections.
    const request = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const result = await request<T>(method, params);
      if (method === "codexhost/harness/inspect" && params.harnessId === "other")
        return {
          status: "unavailable",
          error: { code: "unavailable", message: "Removed", retryable: true },
        } as T;
      return result;
    };
    // A browser-level response fixture represents the existing shared catalog refresh.
    await page.route("**/api/session/modelCatalog", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.result.ok)
        body.result.value.groups = body.result.value.groups.filter(
          (g: { id: string }) => g.id !== "other",
        );
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await composer.waitFor();
    await plus.click();
    await menu.getByRole("option", { name: "Twin fake", exact: true }).waitFor();
    assert.equal(await menu.getByRole("option", { name: "Twin other", exact: true }).count(), 0);
    assert.equal(writeMethods().length, 0);
  },
);
