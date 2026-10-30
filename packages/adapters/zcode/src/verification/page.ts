import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HarnessLocalPage } from "@codexhost/harness-adapter/plugin";
import { ZcodeError } from "../errors.js";
import type { CaptchaConfig } from "./config.js";
import {
  diagnose,
  pageNumber,
  sdkCallback,
  visibilityState,
  type VerificationRecord,
  type VerificationResult,
} from "./diagnostics.js";

const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const MAX_BODY_BYTES = 65_536;
/** How long a verification line waits for the page's frame measurement after the task ends. */
const REPORT_WAIT_MS = 2_000;

/** Desktop's timings; injectable so experiments can test how long traceless really takes. */
export interface VerificationTiming {
  /** How long a new page may take to load the SDK script and its first instance. */
  readyTimeoutMs: number;
  /** Desktop waits 10 seconds for each verification's SDK instance. */
  instanceTimeoutMs: number;
  /** Desktop turns a silent traceless attempt into an interactive challenge after 8 seconds. */
  tracelessTimeoutMs: number;
  /** Desktop gives an interactive challenge 120 seconds in total. */
  interactiveTimeoutMs: number;
}
export const DEFAULT_TIMING: VerificationTiming = {
  readyTimeoutMs: 12_000,
  instanceTimeoutMs: 10_000,
  tracelessTimeoutMs: 8_000,
  interactiveTimeoutMs: 120_000,
};

type PageMessage = { type: "verify" | "interactive" | "cancel"; id: string };
type CloseCause =
  | "stream_closed"
  | "component_error"
  | "not_loaded"
  | "open_cancelled"
  | "open_failed"
  | "released";

/**
 * One background page serving many sequential verifications. The SDK script and the task stream
 * live as long as the page; each verification gets a fresh SDK instance, as in ZCode Desktop,
 * because a reused instance answers its next traceless attempt with F008 (repeated submission).
 */
export interface VerificationPage {
  readonly config: CaptchaConfig;
  readonly closed: boolean;
  verify(signal: AbortSignal, record: VerificationRecord): Promise<string>;
  close(): Promise<void>;
}

interface Task {
  readonly id: string;
  readonly page: HarnessLocalPage;
  readonly record: VerificationRecord;
  readonly pushedAt: number;
  interactive: boolean;
  timer?: NodeJS.Timeout;
  resolve(proof: string): void;
  reject(error: Error, result: VerificationResult): void;
}

/**
 * Runs in the page only. The server owns every timeout, so a paused page cannot stall a task.
 * Each controller owns one SDK instance; callbacks from any instance but the current one are
 * reported as stale and otherwise ignored.
 */
const PAGE_SCRIPT = String.raw`
const $ = (selector) => document.querySelector(selector);
const status = $("#status"), cancel = $("#cancel");
let button = $("#verify"), scriptLoadedAt = 0, instances = 0, connected = false, prewarmed, active;
const post = (kind, body) => fetch("/" + kind + "?token=" + token, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
// Diagnostics carry timings and SDK status fields only, never the proof.
const diag = (body) => void post("diag", { ...body, at: Date.now(), visibility: document.visibilityState }).catch(() => {});
const lifecycle = (name, fields) => diag({ kind: "lifecycle", name, ...fields });
document.addEventListener("visibilitychange", () => lifecycle("visibilitychange"));
const idle = (text) => { status.textContent = text; button.disabled = cancel.disabled = true; };
const owns = (controller) => !controller.discarded && (controller === active || controller === prewarmed);
// Dropping an instance clears its mount and replaces the trigger button, so its listeners go too.
const discard = (controller) => {
  controller.discarded = true;
  if (active === controller) active = undefined;
  if (prewarmed === controller) prewarmed = undefined;
  $("#captcha").replaceChildren();
  const fresh = button.cloneNode(true);
  button.replaceWith(fresh);
  button = fresh;
};
const finish = (controller, kind, body) => {
  const id = controller.task;
  discard(controller);
  idle(kind === "result" ? "验证已完成，任务将继续。" : "本次验证未完成。");
  void post(kind, { id, ...body });
};
const connect = () => {
  connected = true;
  const events = new EventSource("/events?token=" + token);
  events.onmessage = (event) => void receive(JSON.parse(event.data));
  events.onerror = () => { events.close(); idle("验证页已失效，可以关闭。"); };
  idle("验证组件已就绪，任务需要时会自动验证。");
};
const create = (assign) => {
  const controller = { seq: ++instances, discarded: false };
  controller.ready = new Promise((resolve) => { controller.resolveReady = resolve; });
  assign(controller);
  const callback = (name, fields) => diag({
    kind: "sdk", callback: name, instance: controller.seq, stale: !owns(controller),
    id: owns(controller) ? controller.task : undefined, ...fields,
  });
  $("#captcha").replaceChildren();
  try {
    window.initAliyunCaptcha({
      SceneId: config.sceneId, mode: "popup", language: "cn", element: "#captcha", button: "#verify",
      getInstance(value) {
        // The SDK may call this again (for example when its popup opens); keep the task running.
        lifecycle("instance", { instance: controller.seq, stale: !owns(controller) });
        if (!owns(controller)) return;
        controller.instance = value;
        controller.resolveReady();
        if (!connected) connect();
      },
      success(proof) {
        callback("success", {});
        if (owns(controller) && controller.task) finish(controller, "result", { proof });
      },
      fail(value) {
        const fields = value && typeof value === "object" ? value : {};
        const verifyCode = fields.verifyCode ?? fields.VerifyCode;
        callback("fail", { success: fields.success, verifyResult: fields.verifyResult, verifyCode });
        if (!owns(controller) || !controller.task) return;
        if ((fields.success === true && fields.verifyResult === true) || verifyCode === "T006") {
          const proof = fields.captchaVerifyParam ?? fields.CaptchaVerifyParam;
          // Without a proof here, the SDK delivers it through success() afterwards.
          if (typeof proof === "string" && proof.trim()) finish(controller, "result", { proof });
        } else if (verifyCode === "F008") finish(controller, "duplicate", {});
        else if (fields.success === true && fields.verifyResult === false)
          void post("interactive", { id: controller.task });
        else finish(controller, "error", {});
      },
      onError(error) {
        callback("onError", { errorCode: error?.code ?? error?.Code, errorName: error?.name });
        if (!owns(controller)) return;
        if (controller.task) finish(controller, "error", {});
        else discard(controller);
      },
    });
  } catch {
    if (controller.task) finish(controller, "error", {});
    else { discard(controller); void post("error", {}); }
  }
  return controller;
};
const measure = (id) => {
  // One frame shows whether this hidden page is still rendering; give up after one second.
  const receivedAt = Date.now();
  let reported = false;
  const report = (raf) => { if (!reported) { reported = true; diag({ kind: "task", id, receivedAt, raf }); } };
  requestAnimationFrame(() => report(Date.now() - receivedAt));
  setTimeout(() => report(">1000"), 1000);
};
const receive = async (message) => {
  if (message.type === "verify") {
    if (active) discard(active);
    // The prewarmed instance serves the first verification only.
    const controller = prewarmed ?? create((value) => { active = value; });
    if (controller === prewarmed) { prewarmed = undefined; active = controller; }
    controller.task = message.id;
    measure(message.id);
    status.textContent = "正在进行账号验证…";
    cancel.disabled = false;
    await controller.ready;
    // Desktop starts traceless verification no sooner than 2 seconds after the script loaded.
    const wait = scriptLoadedAt + 2000 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (active !== controller) return;
    void post("started", { id: message.id, instance: controller.seq });
    try { controller.instance.startTracelessVerification(); } catch { finish(controller, "error", {}); }
  } else if (!active || message.id !== active.task) return;
  else if (message.type === "interactive") {
    status.textContent = "请完成账号验证，完成后任务自动继续。";
    button.disabled = false;
    button.click();
  } else { discard(active); idle("请求已结束。"); }
};
cancel.onclick = () => {
  if (!active) return;
  const id = active.task;
  discard(active);
  idle("已取消验证。");
  void post("cancel", { id });
};
window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
const script = document.createElement("script");
script.src = sdkUrl;
script.onerror = () => { lifecycle("script_failed"); void post("error", {}); };
script.onload = () => {
  scriptLoadedAt = Date.now();
  lifecycle("script_loaded");
  // Prewarm: one instance ready before the first task; the page is ready once it exists.
  create((value) => { prewarmed = value; });
};
document.head.append(script);
`;

export function verificationPage(config: CaptchaConfig, token: string): string {
  const data = JSON.stringify({
    config: { region: config.region, prefix: config.prefix, sceneId: config.sceneId },
    token,
    sdkUrl: SDK_URL,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZCode 账号验证</title>
<style>body{font:16px system-ui;background:#f5f5f4;color:#252525;margin:0;display:grid;place-items:center;min-height:100vh}main{background:white;border-radius:16px;padding:36px;max-width:460px;margin:24px;box-shadow:0 5px 30px #0001}h1{font-size:24px}p{line-height:1.6;color:#575757}button{font:inherit;border:0;border-radius:8px;padding:12px 22px;cursor:pointer;background:#252525;color:white}#cancel{background:transparent;color:#575757}#status{min-height:50px}</style>
<main><h1>ZCode 账号验证</h1><p>此页在后台为所有 ZCode 任务完成账号验证，需要操作时会自动显示。请保持打开。</p><div id="captcha"></div><p id="status">正在加载验证组件…</p><button id="verify" disabled>继续验证</button><button id="cancel" disabled>取消</button></main>
<script>const {config,token,sdkUrl}=${data};${PAGE_SCRIPT}</script></html>`;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("body too large");
  }
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object") throw new Error("invalid body");
  return value as Record<string, unknown>;
}

/**
 * Starts a loopback server, opens its page once and waits until the SDK instance is ready. Tasks
 * are pushed over one event stream; results come back as same-origin POSTs carrying the task id.
 * The page dies when its stream closes (tab closed or reloaded) or the SDK fails. `sequence`
 * numbers the page in diagnostics.
 */
export async function openVerificationPage(
  config: CaptchaConfig,
  openLocalPage: (url: string) => Promise<HarnessLocalPage>,
  signal: AbortSignal,
  sequence: number,
  timing: VerificationTiming = DEFAULT_TIMING,
): Promise<VerificationPage> {
  // An abort listener never fires for a signal that is already aborted.
  signal.throwIfAborted();
  const token = randomBytes(24).toString("base64url");
  const openedAt = Date.now();
  const age = () => Date.now() - openedAt;
  let origin = "";
  let stream: ServerResponse | undefined;
  let task: Task | undefined;
  let local: HarnessLocalPage | undefined;
  let closing: Promise<void> | undefined;
  let verifications = 0;
  // Page reports can arrive after their task ended; keep records until their line is written.
  const reports = new Map<
    string,
    { record: VerificationRecord; pushedAt: number; frame(): void }
  >();
  const ready = Promise.withResolvers<undefined>();
  void ready.promise.catch(() => undefined);
  diagnose("page_open", { page: sequence });

  const push = (message: PageMessage): void => {
    stream?.write(`data: ${JSON.stringify(message)}\n\n`);
  };
  // The traceless timeout runs from the page's actual start, like Desktop's, not from delivery.
  const started = (current: Task, instance: number | undefined): void => {
    if (current.interactive) return;
    if (instance !== undefined) current.record.instance = instance;
    current.record.startedMs = Date.now() - current.pushedAt;
    clearTimeout(current.timer);
    current.timer = setTimeout(() => interactive(current, "timeout"), timing.tracelessTimeoutMs);
  };
  const interactive = (current: Task, trigger: "sdk" | "timeout"): void => {
    if (current.interactive) return;
    current.interactive = true;
    current.record.interactiveTrigger = trigger;
    current.record.shown = true;
    clearTimeout(current.timer);
    current.timer = setTimeout(
      () =>
        current.reject(
          new ZcodeError("authenticationRequired", "ZCode verification expired"),
          "expired",
        ),
      timing.interactiveTimeoutMs,
    );
    // Showing also brings a paused background page back to life.
    current.page.show().then(
      () => push({ type: "interactive", id: current.id }),
      () =>
        current.reject(new ZcodeError("unavailable", "Could not show ZCode verification"), "error"),
    );
  };
  const close = (
    reason = "ZCode verification page closed",
    cause: CloseCause = "stream_closed",
  ): Promise<void> => {
    closing ??= (async () => {
      diagnose("page_closed", { page: sequence, pageAgeMs: age(), cause });
      const error = new ZcodeError("unavailable", reason, true);
      ready.reject(error);
      task?.reject(error, cause === "component_error" ? "error" : "page_closed");
      stream?.end();
      await local?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    })();
    return closing;
  };
  const report = (body: Record<string, unknown>): void => {
    const visibility = visibilityState(body.visibility);
    const entry = typeof body.id === "string" ? reports.get(body.id) : undefined;
    if (body.kind === "task" && entry) {
      const receivedAt = pageNumber(body.receivedAt);
      if (receivedAt !== undefined) entry.record.deliveryMs = receivedAt - entry.pushedAt;
      if (visibility) entry.record.visibility = visibility;
      const raf = pageNumber(body.raf);
      entry.record.rafDelayMs = raf ?? ">1000";
      entry.frame();
    } else if (body.kind === "sdk" && entry) {
      const callback = sdkCallback(body, entry.pushedAt);
      if (callback) entry.record.sdk.push(callback);
    } else if (body.kind === "sdk") {
      // Callbacks of a discarded or unassigned instance: logged, never routed to a task.
      const callback = sdkCallback(body, openedAt);
      if (callback)
        diagnose("page_sdk_callback", {
          page: sequence,
          instance: pageNumber(body.instance),
          stale: body.stale === true,
          ...callback,
        });
    } else if (body.kind === "lifecycle") {
      const name = body.name;
      if (
        name === "script_loaded" ||
        name === "script_failed" ||
        name === "instance" ||
        name === "visibilitychange"
      )
        diagnose(`page_${name}`, {
          page: sequence,
          pageAgeMs: age(),
          visibility,
          ...(name === "instance"
            ? { instance: pageNumber(body.instance), stale: body.stale === true }
            : {}),
        });
    }
  };

  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    let url: URL;
    try {
      url = new URL(request.url ?? "", origin);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (
      closing ||
      request.headers.host !== new URL(origin).host ||
      url.searchParams.get("token") !== token
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(verificationPage(config, token));
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      if (stream) {
        response.writeHead(409).end();
        return;
      }
      stream = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      response.once("close", () => void close());
      diagnose("page_ready", { page: sequence, pageAgeMs: age() });
      ready.resolve(undefined);
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers.origin !== origin ||
      !["/result", "/started", "/interactive", "/duplicate", "/error", "/cancel", "/diag"].includes(
        url.pathname,
      )
    ) {
      response.writeHead(403).end();
      return;
    }
    void readBody(request).then(
      (body) => {
        response.writeHead(204).end();
        if (url.pathname === "/diag") return report(body);
        // Without a task the SDK script or its first instance failed: the page is unusable.
        if (url.pathname === "/error" && body.id === undefined) {
          void close("ZCode verification component failed", "component_error");
          return;
        }
        const current = task;
        if (!current || body.id !== current.id) return;
        if (url.pathname === "/started") started(current, pageNumber(body.instance));
        else if (url.pathname === "/interactive") interactive(current, "sdk");
        else if (url.pathname === "/error")
          current.reject(new ZcodeError("unavailable", "ZCode verification failed", true), "error");
        else if (url.pathname === "/duplicate") {
          // Desktop resets its SDK instance and fails the attempt; the page stays usable.
          current.record.duplicate = true;
          current.reject(
            new ZcodeError("unavailable", "ZCode verification was a repeated submission", true),
            "error",
          );
        } else if (url.pathname === "/cancel")
          current.reject(
            new ZcodeError("authenticationRequired", "ZCode verification cancelled"),
            "cancelled",
          );
        else if (typeof body.proof === "string" && body.proof.trim()) current.resolve(body.proof);
      },
      () => response.writeHead(400).end(),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const abort = (): void => void close("ZCode verification cancelled", "open_cancelled");
  let deadline: NodeJS.Timeout | undefined;
  signal.addEventListener("abort", abort, { once: true });
  let opened: HarnessLocalPage;
  try {
    opened = local = await openLocalPage(`${origin}/?token=${token}`).catch(() => {
      throw new ZcodeError("unavailable", "Could not open the ZCode verification page", true);
    });
    if (closing) await opened.close();
    deadline = setTimeout(
      () => void close("ZCode verification page did not load", "not_loaded"),
      timing.readyTimeoutMs,
    );
    await ready.promise;
  } catch (error) {
    await close("ZCode verification page closed", "open_failed");
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  }

  return {
    config,
    get closed() {
      return closing !== undefined;
    },
    close: () => close("ZCode verification page closed", "released"),
    async verify(signal, record) {
      signal.throwIfAborted();
      if (closing) throw new ZcodeError("unavailable", "ZCode verification page closed", true);
      record.page = sequence;
      record.pageAgeMs = age();
      record.pageVerification = ++verifications;
      const result = Promise.withResolvers<string>();
      const frame = Promise.withResolvers<undefined>();
      const finish = (outcome: VerificationResult): boolean => {
        if (task !== current) return false;
        task = undefined;
        record.result = outcome;
        clearTimeout(current.timer);
        signal.removeEventListener("abort", cancel);
        // The line waits briefly for the page's frame report, without delaying the result.
        record.settled = Promise.race([
          frame.promise,
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), REPORT_WAIT_MS)),
        ]).then(() => {
          record.rafDelayMs ??= "unreported";
          reports.delete(current.id);
        });
        return true;
      };
      const current: Task = {
        id: randomBytes(12).toString("base64url"),
        page: opened,
        record,
        pushedAt: Date.now(),
        interactive: false,
        resolve(proof) {
          if (finish(current.interactive ? "interactive_passed" : "traceless_passed"))
            result.resolve(proof);
        },
        reject(error, outcome) {
          if (!finish(outcome)) return;
          if (!closing) push({ type: "cancel", id: current.id });
          result.reject(error);
        },
      };
      const cancel = (): void => current.reject(signal.reason as Error, "cancelled");
      task = current;
      reports.set(current.id, {
        record,
        pushedAt: current.pushedAt,
        frame: () => frame.resolve(undefined),
      });
      signal.addEventListener("abort", cancel, { once: true });
      current.timer = setTimeout(
        () =>
          current.reject(
            new ZcodeError("unavailable", "ZCode verification component did not start", true),
            "error",
          ),
        timing.instanceTimeoutMs,
      );
      push({ type: "verify", id: current.id });
      return result.promise;
    },
  };
}
