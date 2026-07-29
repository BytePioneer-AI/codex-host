import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PiRpcClient } from "./rpc-client.mjs";

const fakePi = path.resolve(import.meta.dirname, "fixtures/fake-pi.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createPiScript(directory, baseName = "pi") {
  if (process.platform === "win32") {
    const script = path.join(directory, `${baseName}.cmd`);
    fs.writeFileSync(script, `@echo off\r\n"${process.execPath}" "${fakePi}" %*\r\n`, "utf8");
    return script;
  }
  const script = path.join(directory, baseName);
  fs.writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`, "utf8");
  fs.chmodSync(script, 0o755);
  return script;
}

async function expectEcho(options) {
  const rpc = new PiRpcClient({
    commandTimeoutMs: 5_000,
    closeGraceMs: 500,
    forceGraceMs: 2_000,
    ...options,
  });
  await rpc.start();
  const response = await rpc.send({ type: "echo", value: "ok" });
  expect(response.data.echoed).toBe("ok");
  await rpc.close();
  return rpc.commandSource;
}

describe("Gate C process launch forms", () => {
  it("launches an injected direct executable with prefix argv", async () => {
    await expect(expectEcho({ configuredCommand: [process.execPath, fakePi] })).resolves.toBe(
      "configured",
    );
  });

  it("launches PI_COMMAND as a single script path containing spaces", async () => {
    const directory = temporaryDirectory("codexhost gate-c space ");
    const script = createPiScript(directory, "fake pi");
    await expect(expectEcho({ env: { ...process.env, PI_COMMAND: script } })).resolves.toBe(
      "environment",
    );
  });

  it("discovers the default pi command through PATH", async () => {
    const directory = temporaryDirectory("codexhost-gate-c-path-");
    createPiScript(directory);
    const env = { ...process.env, PI_COMMAND: undefined };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${directory}${path.delimiter}${env[pathKey] ?? ""}`;
    delete env.PI_COMMAND;
    await expect(expectEcho({ env })).resolves.toBe("path");
  });
});
