import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createZcodeVerifier } from "../../packages/adapters/zcode/src/verification/index.js";

const executablePath = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (executablePath) test.use({ launchOptions: { executablePath } });

const captcha = { enabled: true, region: "fixture-region", prefix: "fixture", sceneId: "fixture" };
const realFetch = globalThis.fetch;

/**
 * Synthetic SDKs; each counts its own loads through the route handler. Like the real SDK, an
 * instance answers a second traceless attempt with F008 (repeated submission).
 */
const SDK = {
  traceless: `window.initAliyunCaptcha = o => {
    window.fixtureInits = (window.fixtureInits ?? 0) + 1;
    let used = false;
    o.getInstance({ startTracelessVerification() {
      if (used) return o.fail({ success: true, verifyResult: false, verifyCode: "F008" });
      used = true;
      const n = (window.fixtureRuns = (window.fixtureRuns ?? 0) + 1);
      setTimeout(() => o.success("traceless-proof-" + n), 20);
    }});
  };`,
  // The first instance answers once more, late, while the next verification is still running.
  lateCallback: `window.initAliyunCaptcha = o => {
    const n = (window.fixtureInits = (window.fixtureInits ?? 0) + 1);
    o.getInstance({ startTracelessVerification() {
      setTimeout(() => o.success("traceless-proof-" + n), n === 1 ? 20 : 600);
      if (n === 1) setTimeout(() => o.success("stale-proof-1"), 300);
    }});
  };`,
  // The first instance answers F008 at once; later instances pass.
  duplicateFirst: `window.initAliyunCaptcha = o => {
    const n = (window.fixtureInits = (window.fixtureInits ?? 0) + 1);
    o.getInstance({ startTracelessVerification() {
      if (n === 1) o.fail({ success: true, verifyResult: false, verifyCode: "F008" });
      else setTimeout(() => o.success("traceless-proof-" + n), 20);
    }});
  };`,
  // After show(), the real SDK called getInstance again before the user's success. Its popup is
  // rendered into the mount element, which is cleared when the instance is discarded.
  interactive: `window.initAliyunCaptcha = o => {
    const instance = { startTracelessVerification() { o.fail({ success: true, verifyResult: false }); } };
    document.querySelector(o.button).addEventListener("click", () => {
      if (document.querySelector("#fixture-challenge")) return;
      o.getInstance(instance);
      o.getInstance(instance);
      const challenge = document.createElement("button");
      challenge.id = "fixture-challenge";
      challenge.textContent = "Complete synthetic challenge";
      challenge.onclick = () => { challenge.remove(); o.success("interactive-proof"); };
      document.querySelector(o.element).append(challenge);
    });
    o.getInstance(instance);
  };`,
};

/** A local Desktop stand-in: every opened page is a new tab of the test browser context. */
async function desktop(context: BrowserContext, sdk: string | "unavailable") {
  let sdkLoads = 0;
  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  await context.route("https://o.alicdn.com/**", (route) => {
    sdkLoads++;
    return sdk === "unavailable"
      ? route.abort()
      : route.fulfill({ contentType: "application/javascript", body: sdk });
  });
  const tabs: Page[] = [];
  let shown = 0;
  const verifier = createZcodeVerifier({
    appVersion: "3.14.3",
    async openLocalPage(url) {
      const tab = await context.newPage();
      tabs.push(tab);
      await tab.goto(url);
      return {
        show: async () => void shown++,
        close: () => tab.close(),
      };
    },
  });
  return {
    verifier,
    tabs,
    shown: () => shown,
    sdkLoads: () => sdkLoads,
    latestTab: async () => {
      await expect.poll(() => tabs.length).toBeGreaterThan(0);
      return tabs[tabs.length - 1] as Page;
    },
  };
}
const request = () => new AbortController().signal;
const proof = (headers: Record<string, string>) => headers["X-Aliyun-Captcha-Verify-Param"];

test.beforeEach(() => {
  // The public client configuration is the only non-local request; answer it locally.
  globalThis.fetch = (input, init) =>
    new URL(input instanceof Request ? input.url : input).hostname === "zcode.z.ai"
      ? Promise.resolve(Response.json({ data: { configs: { captcha } } }))
      : realFetch(input, init);
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("traceless verification reuses one page and SDK script with a new instance per request", async ({
  context,
}) => {
  const host = await desktop(context, SDK.traceless);
  try {
    const sequential = [];
    for (let i = 0; i < 3; i++) sequential.push(proof(await host.verifier.verify(request())));
    const concurrent = (
      await Promise.all([1, 2, 3].map(() => host.verifier.verify(request())))
    ).map(proof);
    expect(new Set([...sequential, ...concurrent]).size).toBe(6);
    expect(host.tabs).toHaveLength(1);
    expect(host.sdkLoads()).toBe(1);
    expect(host.shown()).toBe(0);
    // Six verifications, six instances: the prewarmed one served the first.
    expect(
      await host.tabs[0]?.evaluate(() => (window as { fixtureInits?: number }).fixtureInits),
    ).toBe(6);
    expect(await host.verifier.verify(request())).toMatchObject({
      "X-Aliyun-Captcha-Verify-Region": "fixture-region",
    });
  } finally {
    await host.verifier.close();
  }
  expect(host.tabs[0]?.isClosed()).toBe(true);
});

test("prewarm loads the SDK once without verifying; Sessions then share that page", async ({
  context,
}) => {
  const host = await desktop(context, SDK.traceless);
  try {
    host.verifier.prewarm();
    const tab = await host.latestTab();
    await expect(tab.locator("#status")).toHaveText("验证组件已就绪，任务需要时会自动验证。");
    expect(await tab.evaluate(() => (window as { fixtureRuns?: number }).fixtureRuns)).toBe(
      undefined,
    );
    const sessionA = new AbortController();
    const sessionB = new AbortController();
    const [a, b] = await Promise.all([
      host.verifier.verify(sessionA.signal),
      host.verifier.verify(sessionB.signal),
    ]);
    expect(proof(a)).not.toBe(proof(b));
    expect(host.tabs).toHaveLength(1);
    expect(host.sdkLoads()).toBe(1);
  } finally {
    await host.verifier.close();
  }
});

test("a stale instance's late callback never answers the next request", async ({ context }) => {
  const host = await desktop(context, SDK.lateCallback);
  try {
    expect(proof(await host.verifier.verify(request()))).toBe("traceless-proof-1");
    expect(proof(await host.verifier.verify(request()))).toBe("traceless-proof-2");
  } finally {
    await host.verifier.close();
  }
});

test("F008 fails only that request; the page stays and the next request uses a new instance", async ({
  context,
}) => {
  const host = await desktop(context, SDK.duplicateFirst);
  try {
    await expect(host.verifier.verify(request())).rejects.toThrow("repeated submission");
    expect(proof(await host.verifier.verify(request()))).toBe("traceless-proof-2");
    expect(host.tabs).toHaveLength(1);
    expect(host.sdkLoads()).toBe(1);
    expect(host.shown()).toBe(0);
  } finally {
    await host.verifier.close();
  }
});

test("an interactive challenge returns the user's proof even after getInstance is called again", async ({
  context,
}) => {
  const host = await desktop(context, SDK.interactive);
  try {
    // Two requests on one page: each gets its own instance, shows the page and resolves.
    for (const shown of [1, 2]) {
      const pending = host.verifier.verify(request());
      const tab = await host.latestTab();
      const challenge = tab.getByRole("button", { name: "Complete synthetic challenge" });
      await expect(challenge).toBeVisible();
      // A person takes a while; the repeated getInstance must not have dropped the task meanwhile.
      await tab.waitForTimeout(2_500);
      await challenge.click();
      expect(proof(await pending)).toBe("interactive-proof");
      expect(host.shown()).toBe(shown);
      await expect(tab.locator("#status")).toHaveText("验证已完成，任务将继续。");
    }
    expect(host.tabs).toHaveLength(1);
  } finally {
    await host.verifier.close();
  }
});

test("the page reports visibility, frame delay and SDK callbacks without the proof", async ({
  context,
}) => {
  const output: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const host = await desktop(context, SDK.interactive);
  try {
    const pending = host.verifier.verify(request());
    const tab = await host.latestTab();
    await tab.getByRole("button", { name: "Complete synthetic challenge" }).click();
    expect(proof(await pending)).toBe("interactive-proof");
    const lines = () =>
      output
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("[zcode-verification] "))
        .map((line) => JSON.parse(line.slice(21)) as Record<string, unknown>);
    await expect
      .poll(() => lines().find((line) => line.event === "verification"), { timeout: 5_000 })
      .toMatchObject({
        page: 1,
        pageVerification: 1,
        deliveryMs: expect.any(Number),
        visibility: expect.stringMatching(/^(visible|hidden)$/u),
        rafDelayMs: expect.anything(),
        interactiveTrigger: "sdk",
        shown: true,
        result: "interactive_passed",
        sdk: [{ callback: "fail", success: true, verifyResult: false }, { callback: "success" }],
      });
    const events = lines().map((line) => line.event);
    for (const event of ["page_open", "page_script_loaded", "page_instance", "page_ready"])
      expect(events).toContain(event);
    const text = output.join("");
    expect(text).not.toContain("interactive-proof");
    expect(text).not.toContain("token");
  } finally {
    process.stderr.write = write;
    await host.verifier.close();
  }
});

test("cancelling on the page fails only that request and keeps the page", async ({ context }) => {
  const host = await desktop(context, SDK.interactive);
  try {
    const cancelled = host.verifier.verify(request());
    const tab = await host.latestTab();
    await expect(tab.locator("#fixture-challenge")).toBeVisible();
    await tab.locator("#cancel").click();
    await expect(cancelled).rejects.toThrow("cancelled");
    await expect(tab.locator("#status")).toHaveText("已取消验证。");

    const next = host.verifier.verify(request());
    await tab.getByRole("button", { name: "Complete synthetic challenge" }).click();
    expect(proof(await next)).toBe("interactive-proof");
    expect(host.tabs).toHaveLength(1);
  } finally {
    await host.verifier.close();
  }
});

test("closing the tab fails the pending request and the next request reopens it", async ({
  context,
}) => {
  const host = await desktop(context, SDK.interactive);
  try {
    const pending = host.verifier.verify(request());
    const tab = await host.latestTab();
    await expect(tab.locator("#fixture-challenge")).toBeVisible();
    await tab.close();
    await expect(pending).rejects.toThrow("verification page closed");

    const next = host.verifier.verify(request());
    await expect.poll(() => host.tabs.length).toBe(2);
    await (
      await host.latestTab()
    )
      .getByRole("button", { name: "Complete synthetic challenge" })
      .click();
    expect(proof(await next)).toBe("interactive-proof");
    expect(host.sdkLoads()).toBe(2);
  } finally {
    await host.verifier.close();
  }
});

test("an SDK loading failure fails the request without showing the page", async ({ context }) => {
  const host = await desktop(context, "unavailable");
  try {
    await expect(host.verifier.verify(request())).rejects.toThrow("verification component failed");
    expect(host.shown()).toBe(0);
    await expect.poll(() => host.tabs[0]?.isClosed()).toBe(true);
  } finally {
    await host.verifier.close();
  }
});
