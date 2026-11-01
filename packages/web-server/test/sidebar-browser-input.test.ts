import assert from "node:assert/strict";
import { it } from "node:test";
import { chromium } from "playwright";
import { sidebarBrowserEditableRegions } from "../src/sidebar-browser-input.ts";

it("reports visible text editors, not readonly, disabled, covered or non-text controls", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
  await page.setContent(`
    <style>body{margin:0}input,textarea,div[contenteditable]{display:block;width:180px;height:30px;box-sizing:border-box;margin:0;padding:0;border:0}</style>
    <input id="text"><input type="password"><textarea></textarea>
    <div contenteditable="true"><span>Editable</span></div>
    <input readonly><input disabled><fieldset disabled><input></fieldset>
    <input type="checkbox"><input type="date"><input inputmode="none">
    <input style="visibility:hidden"><input style="display:none">
    <div style="position:relative"><input><div style="position:absolute;inset:0;background:white"></div></div>
    <div id="shadow"></div><iframe style="position:absolute;left:250px;top:200px;width:200px;height:100px;border:0"
      srcdoc="<style>body{margin:0}</style><input style='width:150px;height:30px;border:0;padding:0'>"></iframe>
  `);
  await page.evaluate(() => {
    document
      .querySelector("#shadow")
      ?.attachShadow({ mode: "open" })
      .appendChild(document.createElement("textarea"));
  });
  const regions = await sidebarBrowserEditableRegions(page);
  assert.equal(regions.length, 6);
  assert.deepEqual(regions[0], { x: 0, y: 0, width: 180, height: 30 });
  assert.ok(regions.some((region) => region.x === 250 && region.y === 200));
  await page.locator("#text").evaluate((element) => element.setAttribute("readonly", ""));
  assert.equal((await sidebarBrowserEditableRegions(page)).length, 5);
});
