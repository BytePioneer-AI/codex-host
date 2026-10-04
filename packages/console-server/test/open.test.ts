import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vitest";

import { consoleBuildId, consoleUrl, stopConsoleForUpdate } from "../src/open.js";

const CONSOLE_FIXTURE = `
const http = require("node:http");
const appDirectory = process.argv[1];
const service = process.argv[2];
const server = http.createServer((request, response) => {
  if (request.url === "/api/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ service, appDirectory, pid: process.pid }));
    return;
  }
  if (request.url === "/api/shutdown-for-update") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const expected = JSON.parse(body);
      if (expected.expectedPid !== process.pid || expected.expectedAppDirectory !== appDirectory) {
        response.writeHead(409);
        response.end();
        return;
      }
      response.end("ok");
      server.close(() => process.exit(0));
    });
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

async function startFixture(
  appDirectory: string,
  service = "codexhost-console",
): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  const child = spawn(process.execPath, ["-e", CONSOLE_FIXTURE, appDirectory, service]);
  const lines = createInterface({ input: child.stdout });
  const firstLine = await Promise.race([
    once(lines, "line").then(([line]) => String(line)),
    once(child, "exit").then(() => {
      throw new Error("console fixture exited before listening");
    }),
  ]);
  lines.close();
  return { child, port: Number(firstLine) };
}

async function stopFixture(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}

it("opens the overview containing diagnostics", () => {
  expect(consoleUrl(4399)).toBe("http://127.0.0.1:4399/");
  expect(consoleUrl(26340)).toBe("http://127.0.0.1:26340/");
});

describe("console instance identity", () => {
  it("replaces a source console when only the launch version changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-version-"));
    try {
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "codexhost", version: "0.12.0" }),
      );
      const entry = path.join(root, "packages/console-server/dist/main.js");
      const defaultVersion = await consoleBuildId(entry, {});
      const configured = await consoleBuildId(entry, { CODEXHOST_DEV_VERSION: "0.11.0" });
      expect(configured).not.toBe(defaultVersion);
      expect(await consoleBuildId(entry, { CODEXHOST_DEV_VERSION: "0.11.0" })).toBe(configured);
      expect(await consoleBuildId(entry, { CODEXHOST_DEV_VERSION: "0.13.0" })).not.toBe(configured);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("changes when the console server or its page bundle is replaced", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-build-"));
    try {
      const entry = path.join(directory, "console-server.mjs");
      await writeFile(entry, "first");
      await utimes(entry, 1_000, 1_000);
      const first = await consoleBuildId(entry);
      expect(await consoleBuildId(entry)).toBe(first);
      await writeFile(entry, "second build");
      await utimes(entry, 2_000, 2_000);
      const second = await consoleBuildId(entry);
      expect(second).not.toBe(first);
      const bundle = path.join(directory, "console-web.js");
      await writeFile(bundle, "page");
      expect(await consoleBuildId(entry)).not.toBe(second);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("stops a live console from this installation and waits for its process to exit", async () => {
  const fixture = await startFixture("C:/codexhost/current/app");
  try {
    await stopConsoleForUpdate({
      appDirectory: "C:/codexhost/current/app",
      environment: { CODEXHOST_CONSOLE_PORT: String(fixture.port) },
    });
    if (fixture.child.exitCode === null) await once(fixture.child, "exit");
    expect(fixture.child.exitCode).toBe(0);
  } finally {
    await stopFixture(fixture.child);
  }
});

it("does not stop a live console from a different installation", async () => {
  const fixture = await startFixture("C:/codexhost/other/app");
  try {
    await stopConsoleForUpdate({
      appDirectory: "C:/codexhost/current/app",
      environment: { CODEXHOST_CONSOLE_PORT: String(fixture.port) },
    });
    expect(fixture.child.exitCode).toBeNull();
  } finally {
    await stopFixture(fixture.child);
  }
});

it("blocks update handoff when the port owner cannot be identified", async () => {
  const fixture = await startFixture("C:/codexhost/current/app", "another-service");
  try {
    await expect(
      stopConsoleForUpdate({
        appDirectory: "C:/codexhost/current/app",
        environment: { CODEXHOST_CONSOLE_PORT: String(fixture.port) },
      }),
    ).rejects.toThrow("could not be identified");
    expect(fixture.child.exitCode).toBeNull();
  } finally {
    await stopFixture(fixture.child);
  }
});
