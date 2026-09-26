import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mountCaptcha } from "./captcha-client.mjs";

const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const MAX_PROOF_BYTES = 65_536;

export function verificationPage(config, token) {
  const data = JSON.stringify({
    config: { region: config.region, prefix: config.prefix, sceneId: config.sceneId },
    token,
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZCode 账号验证</title>
<style>body{font:16px system-ui;background:#f5f5f4;color:#252525;margin:0;display:grid;place-items:center;min-height:100vh}main{background:white;border-radius:16px;padding:36px;max-width:460px;margin:24px;box-shadow:0 5px 30px #0001}h1{font-size:24px}p{line-height:1.6;color:#575757}button{font:inherit;border:0;border-radius:8px;padding:12px 22px;cursor:pointer;background:#252525;color:white}#cancel{background:transparent;color:#575757}#status{min-height:50px}</style>
<main><h1>ZCode 账号验证</h1><p>正在验证账号。需要操作时，请按提示完成；任务会自动继续。</p><div id="captcha"></div><p id="status">正在加载验证组件…</p><button id="verify" disabled>继续验证</button><button id="cancel">取消</button></main>
<script>const {config,token}=${data};(${mountCaptcha.toString()})(config,token,${JSON.stringify(SDK_URL)});
</script></html>`;
}

/** One page and one proof for one pending native request. It never reads account credentials. */
export async function requestCaptcha(config, signal, notify, { timeoutMs = 150_000 } = {}) {
  signal.throwIfAborted();
  if (!config || config.enabled === false) return {};
  if (
    ![config.region, config.prefix, config.sceneId].every(
      (v) => typeof v === "string" && v.length > 0,
    )
  )
    throw new Error("ZCode CAPTCHA configuration is unavailable");
  const token = randomBytes(24).toString("base64url");
  const result = Promise.withResolvers();
  void result.promise.catch(() => undefined);
  let settled = false,
    origin;
  const settle = (error, proof) => {
    if (settled) return;
    settled = true;
    error ? result.reject(error) : result.resolve(proof);
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const url = new URL(request.url, origin);
    const pathname = url.pathname;
    if (request.headers.host !== new URL(origin).host || url.searchParams.get("token") !== token) {
      response.writeHead(404).end();
      return;
    }
    if (pathname === "/" && request.method === "GET") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(verificationPage(config, token));
      return;
    }
    if (pathname === "/state" && request.method === "GET") {
      response.writeHead(settled ? 410 : 204).end();
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers.origin !== origin ||
      !["/result", "/cancel", "/interactive", "/error"].includes(pathname)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (settled) {
      response.writeHead(410).end();
      return;
    }
    if (pathname === "/interactive") {
      notify({ event: "verification.interactive", requestId: token });
      response.writeHead(204).end();
      return;
    }
    if (pathname === "/error") {
      response.writeHead(204).end();
      settle(new Error("ZCode CAPTCHA SDK failed"));
      return;
    }
    if (pathname.endsWith("/cancel")) {
      response.writeHead(204).end();
      settle(new Error("ZCode verification cancelled"));
      return;
    }
    let body = "";
    try {
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_PROOF_BYTES) throw new Error();
      }
      const value = JSON.parse(body);
      if (
        typeof value.proof !== "string" ||
        !value.proof.trim() ||
        Buffer.byteLength(value.proof) > MAX_PROOF_BYTES
      )
        throw new Error();
      response.writeHead(204).end();
      settle(undefined, value.proof);
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const abort = () => settle(new Error("ZCode verification cancelled"));
  const timeout = setTimeout(() => settle(new Error("ZCode verification expired")), timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    notify({ event: "verification.required", requestId: token, url: origin + "/?token=" + token });
    const proof = await result.promise;
    signal.throwIfAborted();
    return {
      "X-Aliyun-Captcha-Verify-Param": proof,
      "X-Aliyun-Captcha-Verify-Region": config.region,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    notify({ event: "verification.closed", requestId: token });
    // Let the proof submission acknowledgement flush before releasing the page's connection.
    await new Promise((resolve) => {
      const force = setTimeout(() => server.closeAllConnections(), 1000);
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
    });
  }
}
