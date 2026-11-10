import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

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
