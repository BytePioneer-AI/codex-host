import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function createWindowServer({ extensionDir, state, sprite, harness, action }) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}/`;
  const assets = new Map([
    ["window/index.mjs", "text/javascript; charset=utf-8"],
    ["window/style.css", "text/css; charset=utf-8"],
    ["window/strings.mjs", "text/javascript; charset=utf-8"],
    ["window/harness-icons.mjs", "text/javascript; charset=utf-8"],
    ["assets/codex.png", "image/png"],
    ["shared/sprite.mjs", "text/javascript; charset=utf-8"],
    ["shared/otter.mjs", "text/javascript; charset=utf-8"],
  ]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pet Companion</title><link rel="stylesheet" href="window/style.css"></head><body><main id="pet"></main><script type="module" src="window/index.mjs"></script></body></html>`;
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      ) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url ?? "/", origin);
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const resource = url.pathname.slice(prefix.length);
      if (
        request.method === "POST" &&
        resource === "action" &&
        request.headers["content-type"] === "application/json"
      ) {
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          response.writeHead(400).end();
          return;
        }
        await action(input);
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (resource === "") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(html);
        return;
      }
      if (assets.has(resource)) {
        response.setHeader("content-type", assets.get(resource));
        response.end(await readFile(path.join(extensionDir, resource)));
        return;
      }
      if (resource === "state") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(state()));
        return;
      }
      if (resource === "harness") {
        const id = url.searchParams.get("id");
        const value = id && /^[a-z][a-z0-9._-]{0,127}$/u.test(id) ? await harness?.(id) : null;
        if (!value) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
        return;
      }
      if (resource === "sprite") {
        const value = await sprite();
        if (!value) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader("content-type", value.mime);
        response.end(value.bytes);
        return;
      }
      response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}${prefix}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
