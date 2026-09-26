import { expect, test } from "@playwright/test";
// @ts-expect-error Native runtime modules are JavaScript owned by the ZCode build.
import { requestCaptcha } from "../../packages/adapters/zcode/runtime/captcha.mjs";

const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (executablePath) test.use({ launchOptions: { executablePath } });
const config = { enabled: true, region: "fixture", prefix: "fixture", sceneId: "fixture" };
function begin() {
  const abort = new AbortController();
  const opened = Promise.withResolvers<string>();
  const events: string[] = [];
  const proof: Promise<Record<string, string>> = requestCaptcha(
    config,
    abort.signal,
    (event: { event: string; url: string }) => {
      events.push(event.event);
      if (event.event === "verification.required") opened.resolve(event.url);
    },
  );
  void proof.catch(() => {});
  return { abort, url: opened.promise, proof, events };
}

for (const deferred of [false, true]) {
  test(`native traceless verification completes without showing a panel (deferred=${deferred})`, async ({
    page,
  }) => {
    const request = begin();
    try {
      await page.route("https://o.alicdn.com/**", (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: `window.initAliyunCaptcha = options => options.getInstance({startTracelessVerification(){
          ${deferred ? "options.fail({success:true,verifyResult:true});" : ""}
          setTimeout(()=>options.success('fixture-proof'), 20);
        }});`,
        }),
      );
      await page.goto(await request.url);
      expect(await request.proof).toMatchObject({
        "X-Aliyun-Captcha-Verify-Param": "fixture-proof",
      });
      expect(request.events).not.toContain("verification.interactive");
    } finally {
      request.abort.abort();
    }
  });
}
test("a native interactive challenge shows the panel and waits for a user response", async ({
  page,
}) => {
  const request = begin();
  try {
    await page.route("https://o.alicdn.com/**", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `window.initAliyunCaptcha = options => {
        document.querySelector(options.button).addEventListener('click',()=>{
          if(document.querySelector('#fixture-challenge'))return;
          const challenge=document.createElement('button');challenge.id='fixture-challenge';
          challenge.textContent='Complete synthetic challenge';challenge.onclick=()=>options.success('fixture-interactive-proof');
          document.body.append(challenge);
        });
        options.getInstance({startTracelessVerification(){options.fail({success:true,verifyResult:false});}});
      };`,
      }),
    );
    await page.goto(await request.url);
    await expect.poll(() => request.events).toContain("verification.interactive");
    await page.getByRole("button", { name: "Complete synthetic challenge" }).click();
    expect(await request.proof).toMatchObject({
      "X-Aliyun-Captcha-Verify-Param": "fixture-interactive-proof",
    });
    expect(request.events.filter((e) => e === "verification.interactive")).toHaveLength(1);
  } finally {
    request.abort.abort();
  }
});
test("closing the verification page cancels its pending request", async ({ page }) => {
  const request = begin();
  try {
    await page.route("https://o.alicdn.com/**", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "window.initAliyunCaptcha = options => options.getInstance({startTracelessVerification(){}});",
      }),
    );
    await page.goto(await request.url);
    await page.goto("about:blank");
    await expect(request.proof).rejects.toThrow("cancelled");
  } finally {
    request.abort.abort();
  }
});

test("an SDK loading failure fails the request without asking for manual verification", async ({
  page,
}) => {
  const request = begin();
  try {
    await page.route("https://o.alicdn.com/**", (route) => route.abort());
    await page.goto(await request.url);
    await expect(request.proof).rejects.toThrow("SDK failed");
    expect(request.events).not.toContain("verification.interactive");
  } finally {
    request.abort.abort();
  }
});
