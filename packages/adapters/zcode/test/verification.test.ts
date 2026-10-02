import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createZcodeVerifier,
  type ZcodeVerifier,
  type ZcodeVerifierOptions,
} from "../src/verification/index.js";
import { createCaptchaConfigSource } from "../src/verification/config.js";
import { DEFAULT_TIMING, verificationPage } from "../src/verification/page.js";

interface Message {
  type: string;
  id: string;
}

const captcha = { enabled: true, region: "test-region", prefix: "test-prefix", sceneId: "scene" };
const realFetch = globalThis.fetch;
let configRequests: URL[];
let captchaConfig: object;

/** Stands in for the browser page: reads the task stream and posts same-origin replies. */
async function connectPage(url: string) {
  const html = await (await realFetch(url)).text();
  const events = new URL(url);
  events.pathname = "/events";
  const stream = new AbortController();
  const response = await realFetch(events, { signal: stream.signal });
  if (!response.body) throw new Error("event stream missing");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const messages: Message[] = [];
  const waiting: ((message: Message) => void)[] = [];
  let buffer = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: "" }));
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const message = JSON.parse(buffer.slice(6, end)) as Message;
        buffer = buffer.slice(end + 2);
        const next = waiting.shift();
        if (next) next(message);
        else messages.push(message);
      }
    }
  })();
  return {
    html,
    next: () =>
      new Promise<Message>((resolve) => {
        const message = messages.shift();
        if (message) resolve(message);
        else waiting.push(resolve);
      }),
    post(kind: string, body: object, origin = new URL(url).origin) {
      const target = new URL(url);
      target.pathname = "/" + kind;
      return realFetch(target, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    close: () => stream.abort(),
  };
}
type Page = Awaited<ReturnType<typeof connectPage>>;

function desktop() {
  const opened: { url: string; show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] =
    [];
  const pages: PromiseWithResolvers<Page>[] = [];
  const slot = (index: number) => (pages[index] ??= Promise.withResolvers<Page>());
  return {
    opened,
    handle(index: number) {
      const handle = opened[index];
      if (!handle) throw new Error(`page ${index} was not opened`);
      return handle;
    },
    page: (index: number) => slot(index).promise,
    openLocalPage: vi.fn((url: string) => {
      const handle = { url, show: vi.fn(async () => {}), close: vi.fn(async () => {}) };
      slot(opened.length).resolve(connectPage(url));
      opened.push(handle);
      return Promise.resolve(handle);
    }),
  };
}

let verifier: ZcodeVerifier | undefined;
function start(
  openLocalPage?: ZcodeVerifierOptions["openLocalPage"],
  timing?: ZcodeVerifierOptions["timing"],
) {
  verifier = createZcodeVerifier({
    appVersion: "9.8.7",
    ...(openLocalPage ? { openLocalPage } : {}),
    ...(timing ? { timing } : {}),
  });
  return verifier;
}
async function answer(page: Page, proof: string) {
  const task = await page.next();
  expect(task.type).toBe("verify");
  expect((await page.post("result", { id: task.id, proof })).status).toBe(204);
  return task;
}

beforeEach(async () => {
  configRequests = [];
  captchaConfig = captcha;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "zcode.z.ai") return realFetch(input, init);
    configRequests.push(url);
    return Response.json({ data: { configs: { captcha: captchaConfig } } });
  });
});
afterEach(async () => {
  await verifier?.close();
  verifier = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ZCode verification page", () => {
  it("serves fresh proofs for sequential requests from one resident page", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    const first = zcode.verify(new AbortController().signal);
    await answer(await host.page(0), "proof-1");
    expect(await first).toEqual({
      "X-Aliyun-Captcha-Verify-Param": "proof-1",
      "X-Aliyun-Captcha-Verify-Region": "test-region",
    });
    const second = zcode.verify(new AbortController().signal);
    await answer(await host.page(0), "proof-2");
    expect((await second)["X-Aliyun-Captcha-Verify-Param"]).toBe("proof-2");
    expect(host.openLocalPage).toHaveBeenCalledTimes(1);
    expect(host.handle(0).show).not.toHaveBeenCalled();
    expect(configRequests).toHaveLength(1);
    expect(configRequests[0]?.searchParams.get("app_version")).toBe("9.8.7");
    expect(configRequests[0]?.searchParams.get("platform")).toBe(
      `${process.platform}-${process.arch}`,
    );
  });

  it("guards the local page with its token, host and origin", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    const pending = zcode.verify(new AbortController().signal);
    const page = await host.page(0);
    const url = new URL(host.handle(0).url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(page.html).toContain("AliyunCaptcha.js");
    expect((await realFetch(new URL("/?token=wrong", url))).status).toBe(404);
    const second = new URL(url);
    second.pathname = "/events";
    expect((await realFetch(second)).status).toBe(409);
    const task = await page.next();
    expect(
      (await page.post("result", { id: task.id, proof: "x" }, "https://foreign.example")).status,
    ).toBe(403);
    expect((await page.post("result", { id: "stale", proof: "x" })).status).toBe(204);
    await page.post("result", { id: task.id, proof: "real" });
    expect((await pending)["X-Aliyun-Captcha-Verify-Param"]).toBe("real");
  });

  it("returns no headers when verification is disabled or incomplete", async () => {
    const host = desktop();
    captchaConfig = { ...captcha, enabled: false };
    const disabled = start(host.openLocalPage);
    expect(await disabled.verify(new AbortController().signal)).toEqual({});
    await disabled.close();
    captchaConfig = { enabled: true, region: "r", prefix: "p" };
    expect(await start(host.openLocalPage).verify(new AbortController().signal)).toEqual({});
    expect(host.openLocalPage).not.toHaveBeenCalled();
  });

  it("honors skip_model_request: returns undefined / no headers when true, returns config when false or absent", async () => {
    const source = createCaptchaConfigSource("9.8.7");

    // skip_model_request: true -> undefined
    captchaConfig = { ...captcha, skip_model_request: true };
    expect(await source(new AbortController().signal)).toBeUndefined();

    // Verifier with skip_model_request: true returns empty headers without opening a page
    const host = desktop();
    const verifierInstance = start(host.openLocalPage);
    expect(await verifierInstance.verify(new AbortController().signal)).toEqual({});
    expect(host.openLocalPage).not.toHaveBeenCalled();
    await verifierInstance.close();

    // skip_model_request: false -> returns config
    const sourceFalse = createCaptchaConfigSource("9.8.7-false");
    captchaConfig = { ...captcha, skip_model_request: false };
    expect(await sourceFalse(new AbortController().signal)).toEqual({
      region: "test-region",
      prefix: "test-prefix",
      sceneId: "scene",
    });

    // skip_model_request absent -> returns config
    const sourceAbsent = createCaptchaConfigSource("9.8.7-absent");
    captchaConfig = { ...captcha };
    delete (captchaConfig as { skip_model_request?: boolean }).skip_model_request;
    expect(await sourceAbsent(new AbortController().signal)).toEqual({
      region: "test-region",
      prefix: "test-prefix",
      sceneId: "scene",
    });
  });

  it("fails clearly without a local in-app browser", async () => {
    await expect(start().verify(new AbortController().signal)).rejects.toThrow(
      "requires the local Codex in-app browser",
    );
  });

  it("shows the page only when the challenge needs interaction", async () => {
    const host = desktop();
    const pending = start(host.openLocalPage).verify(new AbortController().signal);
    const page = await host.page(0);
    const task = await page.next();
    await page.post("interactive", { id: task.id });
    expect(await page.next()).toEqual({ type: "interactive", id: task.id });
    expect(host.handle(0).show).toHaveBeenCalledTimes(1);
    await page.post("result", { id: task.id, proof: "interactive-proof" });
    expect((await pending)["X-Aliyun-Captcha-Verify-Param"]).toBe("interactive-proof");
  });

  it("shows the page when a traceless attempt stays silent", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    const warm = zcode.verify(new AbortController().signal);
    await answer(await host.page(0), "warm");
    await warm;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = zcode.verify(new AbortController().signal);
    const page = await host.page(0);
    const task = await page.next();
    // The traceless timeout runs from the page's start, not from delivery.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.tracelessTimeoutMs);
    expect(host.handle(0).show).not.toHaveBeenCalled();
    await page.post("started", { id: task.id, instance: 2 });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.tracelessTimeoutMs);
    expect(await page.next()).toEqual({ type: "interactive", id: task.id });
    expect(host.handle(0).show).toHaveBeenCalledTimes(1);
    await page.post("result", { id: task.id, proof: "late" });
    expect((await pending)["X-Aliyun-Captcha-Verify-Param"]).toBe("late");
  });

  it("runs requests one at a time and cancels a request without losing the page", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    const abort = new AbortController();
    const first = zcode.verify(abort.signal);
    const queued = new AbortController();
    const skipped = zcode.verify(queued.signal);
    const second = zcode.verify(new AbortController().signal);
    const page = await host.page(0);
    const task = await page.next();
    queued.abort(new Error("queued request cancelled"));
    await expect(skipped).rejects.toThrow("queued request cancelled");
    abort.abort(new Error("request cancelled"));
    await expect(first).rejects.toThrow("request cancelled");
    expect(await page.next()).toEqual({ type: "cancel", id: task.id });
    await page.post("result", { id: task.id, proof: "too-late" });
    await answer(page, "next");
    expect((await second)["X-Aliyun-Captcha-Verify-Param"]).toBe("next");
    expect(host.openLocalPage).toHaveBeenCalledTimes(1);
  });

  it("fails the current request when the page closes and reopens it next time", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    const pending = zcode.verify(new AbortController().signal);
    const page = await host.page(0);
    await page.next();
    page.close();
    await expect(pending).rejects.toThrow("verification page closed");
    expect(host.handle(0).close).toHaveBeenCalled();
    const next = zcode.verify(new AbortController().signal);
    await answer(await host.page(1), "reopened");
    expect((await next)["X-Aliyun-Captcha-Verify-Param"]).toBe("reopened");
  });

  it("fails only the request when its SDK instance errors or reports F008", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    for (const kind of ["error", "duplicate"]) {
      const pending = zcode.verify(new AbortController().signal);
      const page = await host.page(0);
      const task = await page.next();
      await page.post(kind, { id: task.id });
      await expect(pending).rejects.toThrow(
        kind === "error" ? "verification failed" : "repeated submission",
      );
      expect(await page.next()).toEqual({ type: "cancel", id: task.id });
    }
    // The page and its SDK script stay; the next request gets a new instance on it.
    const next = zcode.verify(new AbortController().signal);
    await answer(await host.page(0), "after-errors");
    expect((await next)["X-Aliyun-Captcha-Verify-Param"]).toBe("after-errors");
    expect(host.openLocalPage).toHaveBeenCalledTimes(1);
    expect(host.handle(0).close).not.toHaveBeenCalled();
  });

  it("discards the page when its SDK fails without a task", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    zcode.prewarm();
    const page = await host.page(0);
    await page.post("error", {});
    await vi.waitFor(() => expect(host.handle(0).close).toHaveBeenCalled());
    await expect(realFetch(host.handle(0).url)).rejects.toThrow();
  });

  it("fails a request whose SDK instance never starts", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage, { instanceTimeoutMs: 50 });
    const pending = zcode.verify(new AbortController().signal);
    await (await host.page(0)).next();
    await expect(pending).rejects.toThrow("did not start");
    expect(host.handle(0).show).not.toHaveBeenCalled();
  });

  it("close fails unfinished requests and releases the page and server", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    const running = zcode.verify(new AbortController().signal);
    const queued = zcode.verify(new AbortController().signal);
    await (await host.page(0)).next();
    await zcode.close();
    await expect(running).rejects.toThrow("verification closed");
    await expect(queued).rejects.toThrow("verification closed");
    expect(host.handle(0).close).toHaveBeenCalled();
    await expect(realFetch(host.handle(0).url)).rejects.toThrow();
    await expect(zcode.verify(new AbortController().signal)).rejects.toThrow("verification closed");
  });

  it("serves two Sessions from one page in order; one Session's cancellation spares the other", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    const sessionA = new AbortController();
    const sessionB = new AbortController();
    const a = zcode.verify(sessionA.signal);
    const b = zcode.verify(sessionB.signal);
    const page = await host.page(0);
    const taskA = await page.next();
    // Session A closes while its task runs; Session B's queued task continues on the same page.
    sessionA.abort(new Error("session A closed"));
    await expect(a).rejects.toThrow("session A closed");
    expect(await page.next()).toEqual({ type: "cancel", id: taskA.id });
    await answer(page, "for-b");
    expect((await b)["X-Aliyun-Captcha-Verify-Param"]).toBe("for-b");
    expect(host.openLocalPage).toHaveBeenCalledTimes(1);
    expect(host.handle(0).close).not.toHaveBeenCalled();
  });

  it("keeps a page that is still opening when the Session that asked for it cancels", async () => {
    const host = desktop();
    const release = Promise.withResolvers<undefined>();
    const opening = vi.fn(async (url: string) => {
      await release.promise;
      return host.openLocalPage(url);
    });
    const zcode = start(opening);
    const sessionA = new AbortController();
    const a = zcode.verify(sessionA.signal);
    await vi.waitFor(() => expect(opening).toHaveBeenCalledOnce());
    sessionA.abort(new Error("session A closed"));
    await expect(a).rejects.toThrow("session A closed");
    const b = zcode.verify(new AbortController().signal);
    release.resolve(undefined);
    // A never reached the page, so the first task is B's.
    await answer(await host.page(0), "for-b");
    expect((await b)["X-Aliyun-Captcha-Verify-Param"]).toBe("for-b");
    expect(opening).toHaveBeenCalledTimes(1);
  });

  it("prewarms the page without verifying and reuses it for the first request", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    zcode.prewarm();
    zcode.prewarm();
    const page = await host.page(0);
    const pending = zcode.verify(new AbortController().signal);
    await answer(page, "warm");
    expect((await pending)["X-Aliyun-Captcha-Verify-Param"]).toBe("warm");
    expect(host.openLocalPage).toHaveBeenCalledTimes(1);
  });

  it("does nothing on prewarm when verification is disabled or no page can open", async () => {
    const host = desktop();
    captchaConfig = { ...captcha, enabled: false };
    const disabled = start(host.openLocalPage);
    disabled.prewarm();
    await vi.waitFor(() => expect(configRequests).toHaveLength(1));
    await disabled.close();
    start().prewarm();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(configRequests).toHaveLength(1);
    expect(host.openLocalPage).not.toHaveBeenCalled();
  });

  it("reopens on the next request after a failed prewarm", async () => {
    const host = desktop();
    host.openLocalPage.mockRejectedValueOnce(new Error("in-app browser unavailable"));
    const zcode = start(host.openLocalPage);
    zcode.prewarm();
    await vi.waitFor(() => expect(host.openLocalPage).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = zcode.verify(new AbortController().signal);
    await answer(await host.page(0), "after-failure");
    expect((await pending)["X-Aliyun-Captcha-Verify-Param"]).toBe("after-failure");
    expect(host.openLocalPage).toHaveBeenCalledTimes(2);
  });

  it("does not open a page when close happens while prewarm reads configuration", async () => {
    const host = desktop();
    const release = Promise.withResolvers<undefined>();
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
      await release.promise;
      return Response.json({ data: { configs: { captcha: captchaConfig } } });
    });
    const zcode = start(host.openLocalPage);
    zcode.prewarm();
    await zcode.close();
    release.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.openLocalPage).not.toHaveBeenCalled();
  });

  it("bounds the client configuration request with a timeout", async () => {
    const host = desktop();
    const timeout = new AbortController();
    const bound = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.mocked(globalThis.fetch).mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)),
        ),
    );
    const pending = start(host.openLocalPage).verify(new AbortController().signal);
    await vi.waitFor(() => expect(bound).toHaveBeenCalledWith(15_000));
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    await expect(pending).rejects.toThrow();
    expect(host.openLocalPage).not.toHaveBeenCalled();
  });

  it("close releases a prewarmed page", async () => {
    const host = desktop();
    const zcode = start(host.openLocalPage);
    zcode.prewarm();
    await host.page(0);
    await vi.waitFor(async () => {
      await zcode.close();
      expect(host.handle(0).close).toHaveBeenCalled();
    });
    await expect(realFetch(host.handle(0).url)).rejects.toThrow();
  });

  describe("diagnostics", () => {
    let output: string[];
    beforeEach(() => {
      output = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    });
    const lines = () =>
      output
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("[zcode-verification] "))
        .map(
          (line) =>
            JSON.parse(line.slice("[zcode-verification] ".length)) as Record<string, unknown>,
        );
    // Lines wait up to two seconds for the frame report, so an earlier test's line may arrive
    // late; select this test's line by its outcome.
    const verificationLine = async (result: string) => {
      const find = () =>
        lines().find((line) => line.event === "verification" && line.result === result);
      await vi.waitFor(() => expect(find()).toBeDefined(), { timeout: 5_000 });
      return find();
    };

    it("records one redacted line with page, delivery, SDK and outcome fields", async () => {
      const host = desktop();
      const zcode = start(host.openLocalPage);
      const pending = zcode.verify(new AbortController().signal);
      const page = await host.page(0);
      const task = await page.next();
      await page.post("diag", {
        kind: "task",
        id: task.id,
        receivedAt: Date.now(),
        raf: 16,
        visibility: "hidden",
      });
      await page.post("started", { id: task.id, instance: 1 });
      // A discarded instance's callback is logged but never attributed to the task.
      await page.post("diag", { kind: "sdk", callback: "success", instance: 7, stale: true });
      // The page never sends the proof in a report; the server keeps only whitelisted fields.
      await page.post("diag", {
        kind: "sdk",
        id: task.id,
        callback: "fail",
        at: Date.now(),
        success: true,
        verifyResult: false,
        verifyCode: "F001",
        captchaVerifyParam: "leaked-proof",
      });
      await page.post("interactive", { id: task.id });
      expect(await page.next()).toEqual({ type: "interactive", id: task.id });
      await page.post("result", { id: task.id, proof: "secret-proof" });
      expect((await pending)["X-Aliyun-Captcha-Verify-Param"]).toBe("secret-proof");
      expect(await verificationLine("interactive_passed")).toEqual({
        event: "verification",
        page: 1,
        pageAgeMs: expect.any(Number),
        pageVerification: 1,
        queueMs: expect.any(Number),
        openMs: expect.any(Number),
        deliveryMs: expect.any(Number),
        instance: 1,
        startedMs: expect.any(Number),
        visibility: "hidden",
        rafDelayMs: 16,
        sdk: [
          {
            callback: "fail",
            atMs: expect.any(Number),
            success: true,
            verifyResult: false,
            verifyCode: "F001",
          },
        ],
        interactiveTrigger: "sdk",
        shown: true,
        result: "interactive_passed",
        totalMs: expect.any(Number),
      });
      await zcode.close();
      const events = lines().map((line) => line.event);
      expect(events).toEqual(
        expect.arrayContaining(["page_open", "page_ready", "verification", "page_closed"]),
      );
      expect(lines().find((line) => line.event === "page_closed")).toMatchObject({
        cause: "released",
      });
      expect(lines().find((line) => line.event === "page_sdk_callback")).toMatchObject({
        callback: "success",
        instance: 7,
        stale: true,
      });
      const token = new URL(host.handle(0).url).searchParams.get("token") ?? "";
      const text = output.join("");
      for (const secret of ["secret-proof", "leaked-proof", token, "token", "127.0.0.1"])
        expect(text).not.toContain(secret);
    });

    it("attributes an interactive switch to the traceless timeout with injected timings", async () => {
      const host = desktop();
      const zcode = start(host.openLocalPage, { tracelessTimeoutMs: 50, interactiveTimeoutMs: 50 });
      const pending = zcode.verify(new AbortController().signal);
      const page = await host.page(0);
      const task = await page.next();
      await page.post("started", { id: task.id, instance: 1 });
      expect(await page.next()).toEqual({ type: "interactive", id: task.id });
      await expect(pending).rejects.toThrow("verification expired");
      expect(host.handle(0).show).toHaveBeenCalledOnce();
      expect(await verificationLine("expired")).toMatchObject({
        interactiveTrigger: "timeout",
        shown: true,
        result: "expired",
        rafDelayMs: "unreported",
      });
    });

    it("keeps the Desktop timing by default", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const host = desktop();
      const zcode = start(host.openLocalPage);
      const pending = zcode.verify(new AbortController().signal);
      const page = await host.page(0);
      const task = await page.next();
      // Fetch needs a timer tick under fake timers; advancing by 0 does not move the clock.
      const started = page.post("started", { id: task.id, instance: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await started;
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.tracelessTimeoutMs - 1);
      expect(host.handle(0).show).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await page.next()).toEqual({ type: "interactive", id: task.id });
      await page.post("result", { id: task.id, proof: "p" });
      await pending;
      expect(DEFAULT_TIMING).toEqual({
        readyTimeoutMs: 12_000,
        instanceTimeoutMs: 10_000,
        tracelessTimeoutMs: 8_000,
        interactiveTimeoutMs: 120_000,
      });
    });

    it("records requests that never reach a page", async () => {
      const host = desktop();
      const zcode = start(host.openLocalPage);
      const running = zcode.verify(new AbortController().signal);
      const queued = new AbortController();
      const waiting = zcode.verify(queued.signal);
      const page = await host.page(0);
      const task = await page.next();
      queued.abort(new Error("cancelled in queue"));
      await expect(waiting).rejects.toThrow("cancelled in queue");
      expect(await verificationLine("cancelled")).toEqual({
        event: "verification",
        sdk: [],
        shown: false,
        result: "cancelled",
        totalMs: expect.any(Number),
      });
      await page.post("result", { id: task.id, proof: "p" });
      await running;
    });
  });

  it("keeps configuration out of script context and exposes only instance keys", () => {
    const config = { region: "r", prefix: "</script><script>bad()</script>", sceneId: "s" };
    const html = verificationPage({ ...config, apiKey: "private" } as typeof config, "fixture");
    expect(html).not.toContain("private");
    expect(html).not.toContain("</script><script>bad()");
    expect(html).toContain("\\u003c/script>");
  });
});
