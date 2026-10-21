import { chromium } from "playwright-core";

const url = "http://127.0.0.1:4399/#skills";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Users/brave/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "domcontentloaded" });
try {
  await page.waitForSelector(".console-skills-group, .console-skills-page .settings-hint", {
    timeout: 15000,
  });
} catch (e) {
  console.log("WAIT_FAIL", String(e).slice(0, 120));
}
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const nav = [
    ...document.querySelectorAll("[data-settings-page], .settings-nav__item, nav a, nav button"),
  ]
    .map((n) => (n.textContent || "").trim())
    .filter(Boolean);
  const shell = document.querySelector(".console-skills-page");
  const status =
    shell?.querySelector(".settings-section-label + .settings-hint, p")?.textContent ?? null;
  const statusLine = [...(shell?.querySelectorAll("p") ?? [])].map(
    (p) => p.className + ": " + p.textContent.slice(0, 80),
  );
  const groups = [...document.querySelectorAll(".console-skills-group")].map((g) => {
    const title = g.querySelector("h2")?.textContent ?? "";
    const cats = [...g.querySelectorAll(".console-skills-category")].map((c) => ({
      cat: c.querySelector("h3")?.textContent ?? "",
      n: c.querySelectorAll("li").length,
    }));
    return {
      title,
      catCount: cats.length,
      items: g.querySelectorAll("li").length,
      failures: g.querySelectorAll(".console-skills-failure").length,
      cats,
    };
  });
  return {
    hasNavSkills: nav.some((t) => /skills/i.test(t)),
    nav: nav.slice(0, 20),
    shellFound: !!shell,
    statusLine,
    groups,
    docHeight: document.documentElement.scrollHeight,
  };
});
console.log(JSON.stringify(info, null, 2));
console.log("CONSOLE_ERRORS", JSON.stringify(errors.slice(0, 5)));
await page.screenshot({ path: "/tmp/verify-skills.png", fullPage: false });
await browser.close();
