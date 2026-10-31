const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { publicError } = require("./service.cjs");

const MAX_BODY = 8 * 1024 * 1024;
const ERROR_CODES = new Set([
  "notInstalled",
  "unavailable",
  "authenticationRequired",
  "configurationRequired",
  "sessionNotFound",
  "sessionBusy",
  "checkpointNotFound",
  "unsupported",
  "invalidRequest",
  "invalidState",
  "protocolError",
  "processExited",
  "nativeFailure",
  "internalError",
]);

function publicFailure(error) {
  return {
    code: ERROR_CODES.has(error?.code) ? error.code : "nativeFailure",
    message: publicError(error).message,
    ...(typeof error?.nativeCode === "number" ? { nativeCode: error.nativeCode } : {}),
  };
}

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY)
      throw Object.assign(new Error("TRAE CN bridge request is too large"), {
        code: "invalidRequest",
      });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid bridge JSON"), { code: "invalidRequest" });
  }
}

async function startServer(service, directory) {
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const instanceId = randomUUID();
  const subscriptions = new Set();
  let closed = false;
  let port;

  const server = http.createServer((request, response) => {
    void (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (
        supplied.length !== authorization.length ||
        !timingSafeEqual(supplied, authorization) ||
        request.headers.origin ||
        request.headers.host !== `127.0.0.1:${port}`
      ) {
        json(response, 403, {
          ok: false,
          error: { code: "unavailable", message: "TRAE CN bridge authorization failed" },
        });
        return;
      }
      if (closed) {
        json(response, 503, {
          ok: false,
          error: { code: "unavailable", message: "TRAE CN bridge is closing" },
        });
        return;
      }
      if (
        request.method !== "POST" ||
        !request.headers["content-type"]?.startsWith("application/json")
      ) {
        json(response, 400, {
          ok: false,
          error: { code: "invalidRequest", message: "Expected a JSON POST request" },
        });
        return;
      }
      const input = await body(request);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Object.assign(new Error("Invalid bridge input"), { code: "invalidRequest" });
      if (request.url === "/inspect") {
        json(response, 200, {
          ok: true,
          value: { instanceId, ...(await service.inspect(input.refresh === true)) },
        });
      } else if (request.url === "/call") {
        if (typeof input.method !== "string")
          throw Object.assign(new Error("Missing bridge method"), { code: "invalidRequest" });
        json(response, 200, { ok: true, value: await service.call(input.method, input.input) });
      } else if (request.url === "/subscribe") {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        response.flushHeaders();
        let cancel;
        let finished = false;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          subscriptions.delete(cleanup);
          cancel?.();
        };
        const send = (value) => {
          if (!finished && !response.destroyed) response.write(`${JSON.stringify(value)}\n`);
        };
        const finish = (value) => {
          send(value);
          cleanup();
          response.end();
        };
        subscriptions.add(cleanup);
        response.on("close", cleanup);
        try {
          cancel = await service.subscribe(input, {
            data: (value) => send({ type: "event", value }),
            error: (error) => finish({ type: "error", error: publicFailure(error) }),
            end: () => finish({ type: "end" }),
          });
          if (finished) cancel();
        } catch (error) {
          finish({ type: "error", error: publicFailure(error) });
        }
      } else
        json(response, 404, {
          ok: false,
          error: { code: "invalidRequest", message: "Unknown bridge endpoint" },
        });
    })().catch((error) => {
      if (!response.headersSent) json(response, 400, { ok: false, error: publicFailure(error) });
      else response.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;
  const endpoint = {
    protocolVersion: 1,
    instanceId,
    pid: process.pid,
    port,
    token,
    application: service.application,
    workspaceFolders: service.workspaceFolders,
  };
  const endpointFile = path.join(directory, `bridge-${process.pid}-${instanceId}.json`);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(endpointFile, JSON.stringify(endpoint), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    endpoint,
    endpointFile,
    async close() {
      if (closed) return;
      closed = true;
      for (const cleanup of subscriptions) cleanup();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.unlink(endpointFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

module.exports = { startServer, publicFailure };
