import { chromium } from "playwright-core";

const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Users/brave/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const net = [];
page.on("requestfailed", (r) => net.push("FAIL " + r.url() + " " + (r.failure()?.errorText ?? "")));
page.on("response", (r) => {
  if (!r.ok()) net.push("HTTP " + r.status() + " " + r.url());
});
const logs = [];
page.on("console", (m) => logs.push(m.type() + ": " + m.text().slice(0, 200)));
page.on("pageerror", (e) => logs.push("pageerror: " + String(e).slice(0, 300)));

for (const hash of ["#/skills", "#skills", "#/usage-statistics", "#usage-statistics"]) {
  await page.goto("http://127.0.0.1:4399/" + hash, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    hash: location.hash,
    title: document.title,
    bodyLen: document.body.innerHTML.length,
    text: document.body.innerText.slice(0, 200).replace(/\n+/g, " / "),
    h1: [...document.querySelectorAll("h1")].map((x) => x.textContent).slice(0, 3),
    skillsGroups: document.querySelectorAll(".console-skills-group").length,
  }));
  console.log(JSON.stringify(r));
}
console.log("NET:", JSON.stringify([...new Set(net)].slice(0, 10), null, 2));
console.log("LOGS:", JSON.stringify([...new Set(logs)].slice(0, 10), null, 2));
await browser.close();
