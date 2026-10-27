import { execFile } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { workBuddyInvocation } from "../src/command.js";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  provider: string,
  cli: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
  argumentsOverride?: string[],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wb-bootstrap-"));
  directories.push(directory);
  const platform = process.platform === "win32" ? "win32" : "darwin";
  const bundle =
    platform === "win32"
      ? path.join(directory, "WorkBuddyAI.exe")
      : path.join(directory, "WorkBuddy AI.app", "Contents", "MacOS", "Electron");
  const resources =
    platform === "win32"
      ? path.join(directory, "resources")
      : path.join(directory, "WorkBuddy AI.app", "Contents", "Resources");
  const script = path.join(resources, "app.asar.unpacked", "cli", "bin", "codebuddy");
  const preload = path.join(directory, "binding.cjs");
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, cli);
  await writeFile(preload, `process._linkedBinding = (name) => { ${provider} };`);
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("CODEBUDDY_SIDECAR_") && name !== "WORKBUDDY_AT_REST_ENCRYPTION",
    ),
  );
  Object.assign(environment, extraEnvironment);
  const invocation = workBuddyInvocation(
    { ...environment, CODEXHOST_WORKBUDDY_COMMAND: bundle },
    false,
    { platform, isExecutable: () => true, isDirectory: () => false },
    argumentsOverride,
  );
  // Node simulates the selected Electron runtime; its native binding is the only mocked boundary.
  return run(process.execPath, ["--require", preload, ...invocation.arguments], {
    env: invocation.environment,
    timeout: 10_000,
    windowsHide: true,
  });
}

describe("WorkBuddy bundled credential startup", () => {
  it("authenticates runtime readiness before removing the bootstrap directory", async () => {
    const secret = Buffer.alloc(32, 7).toString("base64");
    const { stdout, stderr } = await fixture(
      `return { loggerGet: () => ${JSON.stringify(JSON.stringify({ version: 1, atRestSecretKey: secret }))} };`,
      `
      const assert = require('node:assert/strict');
      const net = require('node:net');
      const fs = require('node:fs');
      const path = require('node:path');
      const env = process.env;
      const readyPath = env.CODEBUDDY_SIDECAR_READY_SOCKET;
      const readyParams = { protocolVersion:1, sessionId:env.CODEBUDDY_SIDECAR_READY_SESSION_ID, token:env.CODEBUDDY_SIDECAR_READY_TOKEN, pid:process.pid, port:12345 };
      const report = overrides => new Promise((resolve, reject) => {
        const socket = net.createConnection(readyPath);
        let output = '';
        socket.on('error', reject);
        socket.on('connect', () => socket.write(JSON.stringify({jsonrpc:'2.0',id:'native-ready',method:'session.ready',params:{...readyParams,...overrides}})+'\\n'));
        socket.on('data', data => { output += data; });
        socket.on('close', () => resolve(output));
      });
      const server = net.createServer(socket => {
        let input = '';
        socket.on('data', chunk => {
          input += chunk;
          if (!input.includes('\\n')) return;
          socket.end(JSON.stringify({ok:true,policy:'fields'})+'\\n');
          server.close();
        });
        socket.on('close', async () => {
          if (process.platform !== 'win32') assert.equal(fs.existsSync(path.dirname(readyPath)), true);
          for (const invalid of [{token:'wrong'}, {pid:process.pid+1}, {port:0}, {sessionId:'wrong'}, {protocolVersion:2}]) assert.equal(await report(invalid), '');
          const reply = JSON.parse(await report({}));
          assert.deepEqual(reply, {jsonrpc:'2.0',id:'native-ready',result:{ok:true}});
          setImmediate(() => {
            if (process.platform !== 'win32') assert.equal(fs.existsSync(path.dirname(readyPath)), false);
            console.log('ready-accepted');
          });
        });
      });
      server.listen(env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET);
      `,
      {},
      ["--acp", "--serve"],
    );
    expect(stdout.trim()).toBe("ready-accepted");
    expect(stderr).toBe("");
    expect(stdout + stderr).not.toContain(secret);
  });

  it.each([
    ["unset", undefined],
    ["fields", "fields"],
    ["empty", ""],
    ["blank", "   "],
  ])("decrypts existing credentials with a %s encryption policy", async (_name, policy) => {
    const secret = Buffer.alloc(32, 7).toString("base64");
    const key = createHash("sha256").update(secret, "utf8").digest();
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update("fixture-login-token"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const { stdout, stderr } = await fixture(
      `return { loggerGet: () => ${JSON.stringify(JSON.stringify({ version: 1, atRestSecretKey: secret }))} };`,
      `
      const assert = require('node:assert/strict');
      const crypto = require('node:crypto');
      const net = require('node:net');
      const env = process.env;
      if (!env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET) {
        console.error('Authentication required: credential key unavailable');
        process.exit(1);
      }
      assert.deepEqual(process.argv.slice(2), ['--acp']);
      const server = net.createServer(socket => {
        let data = '';
        socket.on('data', chunk => {
          data += chunk;
          if (!data.includes('\\n')) return;
          const request = JSON.parse(data);
          assert.equal(request.pid, process.pid);
          assert.equal(request.sessionId, env.CODEBUDDY_SIDECAR_READY_SESSION_ID);
          assert.equal(request.token, env.CODEBUDDY_SIDECAR_READY_TOKEN);
          assert.equal(request.bootstrap.policy, 'fields');
          const key = Buffer.from(request.bootstrap.symmetricKey.keyBase64, 'base64');
          assert.equal(request.bootstrap.symmetricKey.keyId, crypto.createHash('sha256').update(key).digest('hex').slice(0,16));
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from('${nonce.toString("base64")}', 'base64'));
          decipher.setAuthTag(Buffer.from('${authTag.toString("base64")}', 'base64'));
          assert.equal(Buffer.concat([decipher.update(Buffer.from('${encrypted.toString("base64")}', 'base64')), decipher.final()]).toString(), 'fixture-login-token');
          socket.end(JSON.stringify({ok:true,policy:'fields'})+'\\n');
          server.close();
          console.log('2');
        });
      });
      server.listen(env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET);
      `,
      policy === undefined ? {} : { WORKBUDDY_AT_REST_ENCRYPTION: policy },
    );
    expect(stdout.trim()).toBe("2");
    expect(stderr).toBe("");
    expect(stdout + stderr).not.toContain(secret);
    expect(stdout + stderr).not.toContain("fixture-login-token");
  });

  it("fails closed when the native server never reports readiness", async () => {
    const secret = Buffer.alloc(32, 7).toString("base64");
    await expect(
      fixture(
        `const timer = global.setTimeout; global.setTimeout = (callback, delay, ...args) => timer(callback, delay === 15000 ? 50 : delay, ...args); return {loggerGet: () => ${JSON.stringify(JSON.stringify({ version: 1, atRestSecretKey: secret }))}};`,
        `const net = require('node:net'); const server = net.createServer(socket => {
        socket.once('data', () => { socket.end(JSON.stringify({ok:true,policy:'fields'})+'\\n'); server.close(); });
      }); server.listen(process.env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET);`,
        {},
        ["--acp", "--serve"],
      ),
    ).rejects.toMatchObject({ code: 1, stderr: "WorkBuddy runtime readiness timed out\n" });
  });

  it("keeps older Electron runtimes without the key provider usable", async () => {
    const { stdout } = await fixture(
      `throw Error('No such binding was linked: ' + name);`,
      `if (process.env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET) throw Error('Unexpected bootstrap'); console.log('legacy');`,
    );
    expect(stdout.trim()).toBe("legacy");
  });

  it("preserves a caller-owned managed credential bootstrap", async () => {
    const environment = {
      WORKBUDDY_AT_REST_ENCRYPTION: "fields",
      CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: "existing-bootstrap",
      CODEBUDDY_SIDECAR_READY_SOCKET: "existing-ready",
      CODEBUDDY_SIDECAR_READY_TOKEN: "existing-token",
      CODEBUDDY_SIDECAR_READY_SESSION_ID: "existing-session",
    };
    const { stdout, stderr } = await fixture(
      `process.stderr.write('Unexpected key provider access'); throw Error('Managed child');`,
      `const assert = require('node:assert/strict'); const expected = ${JSON.stringify(environment)};
      for (const [name, value] of Object.entries(expected)) assert.equal(process.env[name], value);
      console.log('managed');`,
      environment,
    );
    expect(stdout.trim()).toBe("managed");
    expect(stderr).toBe("");
  });

  it.each(["disabled", "required"])("preserves the native %s encryption policy", async (policy) => {
    const { stdout, stderr } = await fixture(
      `process.stderr.write('Unexpected key provider access'); throw Error('Native policy');`,
      `const assert = require('node:assert/strict');
      assert.equal(process.env.WORKBUDDY_AT_REST_ENCRYPTION, ${JSON.stringify(policy)});
      assert.equal(process.env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET, undefined);
      console.log('native');`,
      { WORKBUDDY_AT_REST_ENCRYPTION: policy },
    );
    expect(stdout.trim()).toBe("native");
    expect(stderr).toBe("");
  });

  it.each([
    ["bootstrap socket only", { CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: "existing" }],
    [
      "policy and bootstrap socket only",
      {
        WORKBUDDY_AT_REST_ENCRYPTION: "fields",
        CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: "existing",
      },
    ],
    [
      "missing policy",
      {
        CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: "existing",
        CODEBUDDY_SIDECAR_READY_SOCKET: "existing-ready",
        CODEBUDDY_SIDECAR_READY_TOKEN: "existing-token",
        CODEBUDDY_SIDECAR_READY_SESSION_ID: "existing-session",
      },
    ],
    [
      "blank token",
      {
        WORKBUDDY_AT_REST_ENCRYPTION: "fields",
        CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET: "existing",
        CODEBUDDY_SIDECAR_READY_SOCKET: "existing-ready",
        CODEBUDDY_SIDECAR_READY_TOKEN: "   ",
        CODEBUDDY_SIDECAR_READY_SESSION_ID: "existing-session",
      },
    ],
    ["empty ready socket", { CODEBUDDY_SIDECAR_READY_SOCKET: "" }],
  ] as const)("rejects an incomplete managed bootstrap: %s", async (_name, environment) => {
    await expect(
      fixture(
        `process.stderr.write('Unexpected key provider access'); throw Error('Incomplete bootstrap');`,
        `console.log('CLI should not start');`,
        environment,
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("WorkBuddy credential bootstrap environment is incomplete"),
    });
  });

  it("fails before loading the CLI when the native key payload is invalid", async () => {
    await expect(
      fixture(
        `return {loggerGet: () => JSON.stringify({version:1,atRestSecretKey:'private-invalid-key'})};`,
        `console.log('CLI should not start');`,
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("WorkBuddy credential key payload is unsupported"),
    });
  });

  it("stops when the native receiver does not acknowledge credential protection", async () => {
    const secret = Buffer.alloc(32, 7).toString("base64");
    await expect(
      fixture(
        `return {loggerGet: () => ${JSON.stringify(JSON.stringify({ version: 1, atRestSecretKey: secret }))}};`,
        `require('node:net').createServer(socket => socket.on('data', () => socket.end('{"ok":false}\\n'))).listen(process.env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET);`,
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: "WorkBuddy credential bootstrap failed\n",
    });
  });
});
