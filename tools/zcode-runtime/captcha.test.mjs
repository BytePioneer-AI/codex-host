import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLauncherUrlOpener } from "../../packages/host-runtime/src/launcher-url-opener.js";
import {
  requestCaptcha,
  verificationPage,
} from "../../packages/adapters/zcode/runtime/captcha.mjs";

const config = {
  enabled: true,
  region: "test-region",
  prefix: "test-prefix",
  sceneId: "test-scene",
};
function begin(options) {
  const abort = new AbortController();
  const opened = Promise.withResolvers();
  const events = [];
  const proof = requestCaptcha(
    config,
    abort.signal,
    (event) => {
      events.push(event);
      if (event.event === "verification.required") opened.resolve(event.url);
    },
    options,
  );
  void proof.catch(() => undefined);
  return { abort, url: opened.promise, proof, events };
}
describe("ZCode manual verification boundary", () => {
  it("accepts one proof from the matching local page and forwards only native headers", async () => {
    const request = begin();
    const url = await request.url;
    try {
      let handedOff;
      const open = createLauncherUrlOpener(
        { CODEXHOST_LAUNCHER_EXECUTABLE: path.resolve("fixture-launcher") },
        () => {
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stdin.on("data", (chunk) => (handedOff = chunk.toString()));
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      );
      await open(new URL(url));
      expect(handedOff).toBe(url);
      expect((await fetch(new URL("/", url))).status).toBe(404);
      expect((await fetch(new URL("/?token=wrong", url))).status).toBe(404);
      const page = await fetch(url);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).toContain("AliyunCaptcha.js");
      const resultUrl = new URL(url);
      resultUrl.pathname = "/result";
      expect(
        (
          await fetch(resultUrl, {
            method: "POST",
            headers: { Origin: "https://foreign.example", "Content-Type": "application/json" },
            body: JSON.stringify({ proof: "fixture-proof" }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(resultUrl, {
            method: "POST",
            headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
            body: JSON.stringify({ proof: "fixture-proof" }),
          })
        ).status,
      ).toBe(204);
      expect(await request.proof).toEqual({
        "X-Aliyun-Captcha-Verify-Param": "fixture-proof",
        "X-Aliyun-Captcha-Verify-Region": "test-region",
      });
      expect(JSON.stringify(request.events)).not.toContain("fixture-proof");
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      request.abort.abort();
    }
  });
  it("aborts a pending page when the corresponding native request is cancelled", async () => {
    const request = begin();
    const url = await request.url;
    request.abort.abort();
    await expect(request.proof).rejects.toThrow("cancelled");
    await expect(fetch(url)).rejects.toThrow();
    expect(request.events.at(-1).event).toBe("verification.closed");
  });
  it("expires without supplying a fabricated verification result", async () => {
    const request = begin({ timeoutMs: 20 });
    await request.url;
    await expect(request.proof).rejects.toThrow("expired");
  });
  it("keeps unknown config fields out of the page and escapes script context", () => {
    const html = verificationPage(
      { ...config, prefix: "</script><script>bad()</script>", apiKey: "private-value" },
      "fixture",
    );
    expect(html).not.toContain("private-value");
    expect(html).not.toContain("</script><script>bad()");
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("captchaResult:true");
  });
});
