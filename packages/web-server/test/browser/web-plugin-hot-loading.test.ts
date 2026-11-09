/** Hot selection changes through the real carrier and browser module controller, without service restarts. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, type Page } from "playwright";
import { startServer } from "../support/server.ts";
import { seedWebExtension } from "../support/web-extension.ts";

const TOKEN = "hot-browser-local-token";
const ID = "hot-browser-probe";

it(
  "synchronizes two ordinary pages and reconnection while recovery pages remain built-in only",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codexhost-hot-browser-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({
        name: ID,
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.js", "./client": "./client.js" },
        dsh: { client: { platform: "web", inject: [], immediately: true } },
      }),
    );
    writeFileSync(
      join(source, "index.js"),
      `
    export const inject=['webServer'];
    export function apply(ctx) {
      ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/hot-image',handler(_req,res){res.end('image')}}));
      ctx.on('webserver/index-inject',table=>table.push({kind:'html',placement:'head',html:'<meta name="hot-homepage">'}));
    }
  `,
    );
    writeFileSync(
      join(source, "client.js"),
      `
    window.__ModuleLoader__.load({id:${JSON.stringify(ID)},factory:()=>{
      const style=document.createElement('style');
      style.textContent='body{--hot-probe:active}';document.head.appendChild(style);
      return {apply(ctx){ctx.effect(()=>{
        const element=document.createElement('div');element.id='hot-plugin-visible';document.body.appendChild(element);
        return ()=>element.remove();
      })}};
    }});
  `,
    );
    const data = join(root, "data");
    const pkg = seedWebExtension(data, source);
    const registry = join(data, "ui-extensions/installed.json");
    const saved = JSON.parse(readFileSync(registry, "utf8"));
    saved.extensions[0].enabledTargets = [];
    writeFileSync(registry, JSON.stringify(saved));
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data, "--token", TOKEN],
      { authenticated: true },
    );
    const rpc = async (action: string, args: object) => {
      const method = `codexhost/uiExtensions/${action}`;
      const response = await fetch(new URL(`/api/${method}`, url), {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "hot", method, payload: { args } }),
      });
      const reply = await response.json();
      assert.equal(reply.result.ok, true, JSON.stringify(reply));
      return reply.result.value;
    };
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await browser.newPage();
    const recovery = await context.newPage();
    const manager = await context.newPage();
    const errors: string[] = [];
    const pages = [first, second, recovery, manager];
    for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
    const recoveryChannels: string[] = [];
    for (const page of [recovery, manager])
      page.on("request", (request) => {
        if (request.url().includes("plugins/events")) recoveryChannels.push(request.url());
      });
    await first.goto(url);
    await second.goto(url);
    await recovery.goto(new URL("/?extensions=off", url).href);
    await manager.goto(new URL("/extensions", url).href);
    for (const page of [first, second, recovery])
      await page.getByRole("button", { name: /Settings|设置/, exact: true }).waitFor();
    for (const page of pages)
      await page.evaluate(() => {
        (globalThis as { hotPage?: number }).hotPage = 1;
      });
    const visible = async (page: Page, enabled: boolean) => {
      await page
        .locator("#hot-plugin-visible")
        .waitFor({ state: enabled ? "attached" : "detached" });
      assert.equal(await page.locator(`style[data-plugin="${ID}"]`).count(), enabled ? 1 : 0);
      assert.equal(await page.evaluate(() => (globalThis as { hotPage?: number }).hotPage), 1);
    };
    assert.deepEqual((await rpc("setEnabled", { id: ID, enabled: true })).loadedIds, [ID]);
    await visible(first, true);
    await visible(second, true);
    assert.equal((await first.request.get(new URL("/hot-image", url).href)).status(), 200);
    // Index-only contributions apply to new documents, not silently to existing pages.
    assert.equal(await first.locator('meta[name="hot-homepage"]').count(), 0);
    assert.match(await (await first.request.get(new URL("/", url).href)).text(), /hot-homepage/);
    assert.match(
      await manager.locator("body").innerText(),
      /homepage-only injections require a page refresh/i,
    );
    await second.context().setOffline(true);
    await rpc("setEnabled", { id: ID, enabled: false });
    await visible(first, false);
    await second.context().setOffline(false);
    await visible(second, false);
    assert.equal((await first.request.get(new URL("/hot-image", url).href)).status(), 404);
    assert.ok(existsSync(pkg.directory));
    await rpc("setEnabled", { id: ID, enabled: true });
    await visible(first, true);
    await visible(second, true);
    await rpc("remove", { id: ID });
    await visible(first, false);
    await visible(second, false);
    assert.equal(existsSync(pkg.directory), false);
    for (const page of [recovery, manager]) {
      await visible(page, false);
      assert.equal(await page.locator('meta[name="hot-homepage"]').count(), 0);
    }
    assert.deepEqual(recoveryChannels, []);
    assert.deepEqual(errors, []);
  },
);
