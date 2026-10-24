/** Runs inside the selected app's Electron, before its bundled CLI is loaded. */
export const WORKBUDDY_CREDENTIAL_PRELOAD = String.raw`
(() => {
  const env = process.env;
  const bootstrapEnvironment = [
    "CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET",
    "CODEBUDDY_SIDECAR_READY_SOCKET",
    "CODEBUDDY_SIDECAR_READY_TOKEN",
    "CODEBUDDY_SIDECAR_READY_SESSION_ID",
  ];
  if (bootstrapEnvironment.some(name => env[name] !== undefined)) {
    if (!["WORKBUDDY_AT_REST_ENCRYPTION", ...bootstrapEnvironment].every(name => env[name]?.trim())) {
      throw Error("WorkBuddy credential bootstrap environment is incomplete");
    }
    return;
  }
  const policy = env.WORKBUDDY_AT_REST_ENCRYPTION?.trim();
  // "disabled" stays owned by the native CLI; "required" is the legacy name
  // for the same field-encryption bootstrap.
  if (policy && policy !== "fields" && policy !== "required") return;

  let provider;
  try {
    provider = process._linkedBinding("electron_browser_workbuddy_storage");
  } catch {
    // Older app runtimes predate encrypted credential fields.
    return;
  }
  const crypto = require("node:crypto");
  const net = require("node:net");
  const fs = require("node:fs");
  const path = require("node:path");
  let payload;
  try { payload = JSON.parse(provider.loggerGet()); }
  catch { throw Error("WorkBuddy credential key provider is unavailable"); }
  let secret = payload && payload.atRestSecretKey;
  const decoded = typeof secret === "string" ? Buffer.from(secret, "base64") : Buffer.alloc(0);
  const valid = payload && payload.version === 1 && decoded.length === 32 &&
    decoded.toString("base64") === secret && !decoded.every(byte => byte === 0);
  decoded.fill(0);
  if (!valid) throw Error("WorkBuddy credential key payload is unsupported");
  // Match the native normalizeAtRestKeyPayload; the base64 text is hashed, not its decoded bytes.
  const key = crypto.createHash("sha256").update(secret, "utf8").digest();
  secret = undefined;
  payload = undefined;
  // The bundled CLI changed its credential-bootstrap wire format: before 2.156
  // it reads bootstrap.mode and answers with a space-terminated {ok,mode}; from
  // 2.156 it reads bootstrap.policy and answers with a newline-terminated
  // {ok,policy}. The receiver accepts one connection only, so choose the format
  // before connecting instead of retrying.
  let legacyBootstrap = false;
  const cliEntry = process.argv[1];
  if (cliEntry) {
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.resolve(path.dirname(cliEntry), "..", "package.json"), "utf8"),
      );
      const version = String(
        metadata.publishConfig?.customPackage?.version || metadata.version || "",
      );
      const [major, minor] = version.split("-")[0].split(".").map(Number);
      // 0.x is the placeholder version in development packages; keep the
      // format this adapter shipped with.
      if (Number.isInteger(major) && Number.isInteger(minor) && major > 0) {
        legacyBootstrap = major < 2 || (major === 2 && minor < 156);
      }
    } catch {
      // Unreadable package metadata keeps the newer format.
    }
  }
  const protectionMode = legacyBootstrap ? "required" : "fields";
  const bootstrapField = legacyBootstrap ? "mode" : "policy";
  const token = crypto.randomBytes(24).toString("hex");
  const sessionId = crypto.randomUUID();
  let directory;
  let socketPath;
  if (process.platform === "win32") {
    socketPath = "\\\\.\\pipe\\codexhost-wb-" + process.pid + "-" + token;
  } else {
    let root = require("node:os").tmpdir();
    if (Buffer.byteLength(root) > 65) root = "/tmp";
    directory = fs.mkdtempSync(path.join(root, "ch-wb-"));
    fs.chmodSync(directory, 0o700);
    socketPath = path.join(directory, "c");
  }
  const cleanup = () => {
    clearTimeout(readyTimer);
    readyServer && readyServer.close();
    for (const connection of readyConnections) connection.destroy();
    if (directory) try { fs.rmSync(directory, {recursive:true,force:true}); } catch {}
  };
  const needsReady = process.argv.includes("--serve");
  let credentialReady = false;
  let runtimeReady = !needsReady;
  let readyTimer;
  let readyServer;
  const readyConnections = new Set();
  const cleanupWhenReady = () => {
    if (!credentialReady || !runtimeReady) return;
    cleanup();
    process.removeListener("exit", cleanup);
  };
  if (needsReady) {
    readyServer = net.createServer(connection => {
      readyConnections.add(connection);
      connection.once("close", () => readyConnections.delete(connection));
      connection.on("error", () => connection.destroy());
      let input = "";
      connection.on("data", chunk => {
        input += chunk;
        if (input.length > 4096) return connection.destroy();
        if (!input.includes("\n")) return;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          const params = request.params;
          if (request.jsonrpc !== "2.0" || request.method !== "session.ready" ||
              typeof request.id !== "string" || params?.protocolVersion !== 1 ||
              params.token !== token || params.sessionId !== sessionId || params.pid !== process.pid ||
              !Number.isInteger(params.port) || params.port < 1 || params.port > 65535) {
            connection.destroy();
            return;
          }
          runtimeReady = true;
          connection.end(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{ok:true}}) + "\n", cleanupWhenReady);
        } catch { connection.destroy(); }
      });
    });
    readyServer.once("error", () => {
      process.stderr.write("WorkBuddy runtime readiness listener failed\n");
      process.exit(1);
    });
    readyServer.listen(socketPath + "-ready");
    readyTimer = setTimeout(() => {
      process.stderr.write("WorkBuddy runtime readiness timed out\n");
      process.exit(1);
    }, 15000);
  }
  process.once("exit", cleanup);
  Object.assign(env, {
    WORKBUDDY_AT_REST_ENCRYPTION: protectionMode,
    CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: socketPath,
    CODEBUDDY_SIDECAR_READY_SOCKET: socketPath + "-ready",
    CODEBUDDY_SIDECAR_READY_TOKEN: token,
    CODEBUDDY_SIDECAR_READY_SESSION_ID: sessionId,
  });
  const bootstrapPayload = {
    version:1,
    symmetricKey:{keyId:crypto.createHash("sha256").update(key).digest("hex").slice(0,16),keyBase64:key.toString("base64")},
    asymmetricUnavailable:"missing-key",
  };
  // Legacy receivers reject the newer key name and vice versa; exactly one may
  // be present.
  bootstrapPayload[bootstrapField] = protectionMode;
  let message = JSON.stringify({version:1,sessionId,token,pid:process.pid,bootstrap:bootstrapPayload}) + "\n";
  key.fill(0);
  let done = false;
  let socket;
  const finish = success => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket && socket.destroy();
    message = "";
    credentialReady = success;
    if (success) cleanupWhenReady();
    if (!success) {
      process.stderr.write("WorkBuddy credential bootstrap failed\n");
      process.exit(1);
    }
  };
  const timer = setTimeout(() => finish(false), 4500);
  const connect = () => {
    if (done) return;
    socket = net.createConnection(socketPath);
    let reply = "";
    socket.once("connect", () => socket.end(message, () => { message = ""; }));
    // Newer CLIs answer with a newline-terminated {ok,policy} frame; legacy
    // ones answer with a space-terminated {ok,mode} and close immediately.
    const acceptReply = raw => {
      const text = String(raw || "").trim();
      if (!text) return false;
      try {
        const result = JSON.parse(text);
        // The legacy receiver was only validated to acknowledge with ok:true;
        // the newer one echoes the policy it applied.
        if (result && result.ok === true && (legacyBootstrap || result.policy === protectionMode)) {
          finish(true);
          return true;
        }
      } catch {}
      return false;
    };
    socket.on("data", chunk => {
      reply += chunk;
      if (reply.length > 1024) return finish(false);
      if (!reply.includes("\n")) return;
      if (!acceptReply(reply.slice(0, reply.indexOf("\n")))) finish(false);
    });
    socket.once("end", () => { if (!done && !acceptReply(reply)) finish(false); });
    socket.once("error", error => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") setTimeout(connect, 20);
      else finish(false);
    });
  };
  setImmediate(connect);
})();
`;
