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
await page.goto("http://127.0.0.1:4399/", { waitUntil: "load" });
await page.waitForTimeout(3000);
const dump = await page.evaluate(() => {
  const text = document.body.innerText.slice(0, 800);
  const classes = [
    ...new Set([...document.querySelectorAll("[class]")].flatMap((e) => [...e.classList])),
  ].slice(0, 60);
  const links = [...document.querySelectorAll("a")].map(
    (a) => (a.getAttribute("href") || "") + " | " + a.textContent.trim().slice(0, 30),
  );
  return {
    title: document.title,
    hash: location.hash,
    bodyStart: text,
    classes,
    links,
    bodyLen: document.body.innerHTML.length,
  };
});
console.log(JSON.stringify(dump, null, 2));
console.log("LOGS:", JSON.stringify(logs.slice(0, 10), null, 2));
await browser.close();
