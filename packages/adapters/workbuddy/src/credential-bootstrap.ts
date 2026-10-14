/** Runs inside the selected app's Electron, before its bundled CLI is loaded. */
export const WORKBUDDY_CREDENTIAL_PRELOAD = String.raw`
(() => {
  const env = process.env;
  if ([
    "WORKBUDDY_AT_REST_ENCRYPTION",
    "CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET",
    "CODEBUDDY_SIDECAR_READY_SOCKET",
    "CODEBUDDY_SIDECAR_READY_TOKEN",
    "CODEBUDDY_SIDECAR_READY_SESSION_ID",
  ].some(name => env[name] !== undefined)) return;

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
    if (directory) try { fs.rmSync(directory, {recursive:true,force:true}); } catch {}
  };
  process.once("exit", cleanup);
  Object.assign(env, {
    WORKBUDDY_AT_REST_ENCRYPTION: "fields",
    CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: socketPath,
    CODEBUDDY_SIDECAR_READY_SOCKET: socketPath + "-ready",
    CODEBUDDY_SIDECAR_READY_TOKEN: token,
    CODEBUDDY_SIDECAR_READY_SESSION_ID: sessionId,
  });
  let message = JSON.stringify({version:1,sessionId,token,pid:process.pid,bootstrap:{
    version:1,policy:"fields",
    symmetricKey:{keyId:crypto.createHash("sha256").update(key).digest("hex").slice(0,16),keyBase64:key.toString("base64")},
    asymmetricUnavailable:"missing-key",
  }}) + "\n";
  key.fill(0);
  let done = false;
  let socket;
  const finish = success => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket && socket.destroy();
    message = "";
    cleanup();
    process.removeListener("exit", cleanup);
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
    socket.on("data", chunk => {
      reply += chunk;
      if (reply.length > 1024) return finish(false);
      if (!reply.includes("\n")) return;
      try {
        const result = JSON.parse(reply.slice(0, reply.indexOf("\n")));
        finish(result.ok === true && result.policy === "fields");
      } catch { finish(false); }
    });
    socket.once("end", () => { if (!done) finish(false); });
    socket.once("error", error => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") setTimeout(connect, 20);
      else finish(false);
    });
  };
  setImmediate(connect);
})();
`;
