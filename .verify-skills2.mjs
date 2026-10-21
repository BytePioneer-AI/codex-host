import { chromium } from "playwright-core";

const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Users/brave/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const logs = [];
page.on("console", (m) => logs.push(m.type() + ": " + m.text().slice(0, 200)));
page.on("pageerror", (e) => logs.push("pageerror: " + String(e).slice(0, 300)));

await page.goto("http://127.0.0.1:4399/#skills", { waitUntil: "load" });
await page.waitForTimeout(5000);

const probe = async () =>
  page.evaluate(() => {
    const root = document.querySelector(".console-root");
    const sr = root?.shadowRoot;
    if (!sr) return { noShadow: true };
    const q = (sel) => [...sr.querySelectorAll(sel)];
    const navBtn = q(".settings-nav-button").map((b) => b.textContent.trim());
    const groups = q(".console-skills-group").map((g) => ({
      title: g.querySelector("h2")?.textContent?.trim() ?? "",
      items: g.querySelectorAll("li").length,
      failures: g.querySelectorAll(".console-skills-failure").length,
      cats: [...g.querySelectorAll(".console-skills-category")].map((c) => ({
        cat: c.querySelector("h3")?.textContent?.trim() ?? "",
        n: c.querySelectorAll("li").length,
      })),
    }));
    const texts = q("p").map(
      (p) => (p.className || "-") + " :: " + (p.textContent || "").trim().slice(0, 60),
    );
    return {
      hash: location.hash,
      nav: navBtn,
      pageHead: q("h1").map((x) => x.textContent.trim()),
      status: texts.slice(0, 6),
      groups,
      hasSearch: q(".console-skills-search").length,
      docHeight: document.documentElement.scrollHeight,
    };
  });

console.log("=== 初始 ===");
console.log(JSON.stringify(await probe(), null, 2));

// 测试搜索
await page.evaluate(() => {
  const sr = document.querySelector(".console-root")?.shadowRoot;
  const input = sr?.querySelector(".console-skills-search");
  if (input) {
    input.value = "motion";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await page.waitForTimeout(600);
console.log("=== 搜索 motion ===");
console.log(JSON.stringify(await probe(), null, 2));

// 恢复并截全页
await page.evaluate(() => {
  const sr = document.querySelector(".console-root")?.shadowRoot;
  const input = sr?.querySelector(".console-skills-search");
  if (input) {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/verify-skills-top.png" });
await page.evaluate(() => {
  const sr = document.querySelector(".console-root")?.shadowRoot;
  sr?.querySelector(".console-skills-page")?.scrollIntoView(true);
});
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/verify-skills-scrolled.png" });
console.log("LOGS:", JSON.stringify([...new Set(logs)].slice(0, 8), null, 2));
await browser.close();
