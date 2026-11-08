import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createDshWebBackend } from "@codexhost/dsh-web-backend";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "office-engine-test-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    (Module as typeof Module & { _initPaths(): void })._initPaths();
  });
  const target = process.platform === "linux" ? "wasm" : `${process.platform}-${process.arch}`;
  const name = `@deepseek-ai/libreoffice-kit-${target}`;
  const version = "0.1.5";
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "program"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(pkg, "program/soffice"), "fake engine", { mode: 0o755 });
  writeFileSync(
    join(pkg, "prebuilds.json"),
    JSON.stringify({
      schemaVersion: 1,
      status: "built",
      version,
      platform: target,
      engine:
        target === "wasm"
          ? {
              kind: "wasm",
              programDirectory: "program",
              loader: "program/soffice",
              wasm: "program/soffice",
              data: "program/soffice",
              metadata: "program/soffice",
            }
          : { kind: "native", programDirectory: "program", executable: "program/soffice" },
    }),
  );
  execFileSync("tar", ["-czf", "engine.tgz", "package"], { cwd: root });
  const archive = readFileSync(join(root, "engine.tgz"));
  const bundle = join(root, "installer.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/office-engine.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { createOfficeEngine } = await import(pathToFileURL(bundle).href);
  let requests = 0;
  let respond = (_request: unknown, response: ServerResponse): void => {
    response.end(archive);
  };
  const server = createServer((request, response) => {
    requests++;
    respond(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const artifact = {
    name,
    version,
    url: `http://127.0.0.1:${address.port}/engine.tgz`,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  };
  const data = join(root, "data");
  return {
    root,
    data,
    artifact,
    createOfficeEngine: createOfficeEngine as (
      data: string,
      artifacts: (typeof artifact)[],
    ) => () => boolean,
    requests: () => requests,
    respond: (handler: typeof respond) => {
      respond = handler;
    },
    archive,
  };
}

async function untilReady(ensure: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ensure()) {
    assert.ok(Date.now() < deadline, "download did not settle");
    await new Promise((done) => setTimeout(done, 10));
  }
}

it("returns downloading immediately through the preview RPC and keeps downloading after its request aborts", async (t) => {
  const backendCleanup: { close?: () => Promise<void> } = {};
  // Dispose retained terminal children before fixture cleanup removes their cwd.
  t.after(() => backendCleanup.close?.());
  const f = await fixture(t);
  copyFileSync(
    join(import.meta.dirname, "fixtures/office/sample.docx"),
    join(f.root, "sample.docx"),
  );
  let finish!: () => void;
  const received = Promise.withResolvers<undefined>();
  f.respond((_request, response) => {
    finish = () => response.end(f.archive);
    received.resolve(undefined);
  });
  const ensure = f.createOfficeEngine(f.data, [f.artifact]);
  const backend = await createDshWebBackend({
    workspaceRoot: f.root,
    threadWorkspace: () => f.root,
    ensureOfficeEngine: ensure,
  });
  backendCleanup.close = () => backend.close();
  const request = new AbortController();
  const response = await backend.fetch(
    new Request("http://localhost/api/officeToPdf/render", {
      method: "POST",
      signal: request.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "preview",
        method: "officeToPdf/render",
        payload: {
          args: {
            workspaceFileScopeId: "thread",
            path: "sample.docx",
            priority: "foreground",
          },
        },
      }),
    }),
  );
  const result = (await response.json()).result;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "document-render/failed");
  assert.equal(result.error.details.reason, "downloading");
  await received.promise;
  request.abort();
  finish();
  await untilReady(ensure);
  assert.equal(f.requests(), 1);
  assert.equal(ensure(), true);
  const environment = {
    HOME: f.root,
    CODEXHOST_DATA_DIR: f.data,
    CODEX_HOME: join(f.root, "codex"),
    CODEXHOST_CONSOLE_PORT: "4471",
    SSH_CONNECTION: "smoke",
    ...(process.platform === "win32" ? {} : { SHELL: "/bin/sh" }),
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });
  const terminal = await backend.fetch(
    new Request("http://localhost/api/terminal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "terminal",
        method: "terminal/create",
        payload: {
          args: {
            agentId: "thread",
            request: {
              id: "node-path",
              cols: 80,
              rows: 24,
            },
          },
        },
      }),
    }),
  );
  const terminalResult = await terminal.json();
  assert.equal(terminalResult.result.ok, true, JSON.stringify(terminalResult));
  const proof = join(f.root, "terminal-node-path");
  const inputDone = Promise.withResolvers<undefined>();
  const lifetime = new AbortController();
  const stream = await backend.openStream(
    "terminal/attach",
    { agentId: "thread", id: "node-path" },
    lifetime.signal,
    {
      items: (async function* () {
        yield {
          type: "write",
          sequence: 1,
          data:
            process.platform === "win32"
              ? `echo %NODE_PATH% > "${proof}"\r`
              : `printf '%s' "\${NODE_PATH-unset}" > '${proof}'\r`,
        };
        await inputDone.promise;
      })(),
      window: { maxBytes: 262_144, frameOverheadBytes: 0 },
    },
  );
  const reading = (async () => {
    const iterator = stream[Symbol.asyncIterator]();
    while (!(await iterator.next()).done) {
      if (lifetime.signal.aborted) break;
    }
  })();
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(proof)) {
      assert.ok(Date.now() < deadline, "Web terminal did not write NODE_PATH proof");
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(
      readFileSync(proof, "utf8").trim(),
      process.platform === "win32" ? "%NODE_PATH%" : "unset",
    );
  } finally {
    inputDone.resolve(undefined);
    lifetime.abort();
    await assert.rejects(reading, { code: "gateway/cancelled" });
  }
});

it("rejects SHA-512 mismatches without installing the archive", async (t) => {
  const f = await fixture(t);
  const ensure = f.createOfficeEngine(f.data, [{ ...f.artifact, integrity: "sha512-wrong" }]);
  assert.equal(ensure(), false);
  await assert.rejects(untilReady(ensure), /SHA-512/u);
  assert.equal(existsSync(join(f.data, "office-engine", f.artifact.version)), false);
  assert.equal(existsSync(join(f.data, "office-engine/.download")), false);
});

it("reports a network failure then retries on the next preview", async (t) => {
  const f = await fixture(t);
  f.respond((_request, response) => response.destroy());
  const ensure = f.createOfficeEngine(f.data, [f.artifact]);
  assert.equal(ensure(), false);
  await assert.rejects(untilReady(ensure), /fetch failed/u);
  assert.equal(f.requests(), 1);
  f.respond((_request, response) => response.end(f.archive));
  assert.equal(ensure(), false);
  await untilReady(ensure);
  assert.equal(f.requests(), 2);
});
