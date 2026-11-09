import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { consoleBuildId, consoleUrl, stopConsole } from "../src/open.js";

it("opens the overview containing diagnostics", () => {
  expect(consoleUrl(4399)).toBe("http://127.0.0.1:4399/");
  expect(consoleUrl(26340)).toBe("http://127.0.0.1:26340/");
});

describe("console stop", () => {
  it.each(["console", "foreign", "free"])(
    "reports stopping a %s endpoint without starting services",
    async (kind) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "console-stop-"));
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/shutdown") {
          expect(request.headers["x-codexhost-console"]).toBe("1");
          response.end("{}");
          setTimeout(() => server.close(), 200);
        } else {
          response.end(
            JSON.stringify({
              service: kind === "console" ? "codexhost-console" : "other",
              appDirectory: home,
              pid: process.pid,
            }),
          );
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      if (kind === "free") await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const result = await new Promise((resolve) => {
          execFile(
            process.execPath,
            ["--import", "tsx", "src/main.ts", "stop"],
            {
              cwd: path.resolve(import.meta.dirname, ".."),
              env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                CODEX_HOME: path.join(home, "codex"),
                CODEXHOST_DATA_DIR: home,
                CODEXHOST_CONSOLE_PORT: String(port),
              },
            },
            (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
          );
        });
        expect(result).toEqual({ code: kind === "console" ? 0 : 3, stdout: "", stderr: "" });
        expect(requests.filter((request) => request === "POST /api/shutdown")).toHaveLength(
          kind === "console" ? 1 : 0,
        );
        if (kind === "console") expect(server.listening).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("uses the existing port validation", async () => {
    await expect(stopConsole({ CODEXHOST_CONSOLE_PORT: "invalid" })).rejects.toThrow(
      "CODEXHOST_CONSOLE_PORT",
    );
  });
});

describe("console instance identity", () => {
  it("does not reuse a console that discovers Hosts in a different data directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-data-"));
    try {
      const entry = path.join(root, "console-server.mjs");
      await writeFile(entry, "same build");
      const local = { CODEXHOST_DATA_DIR: path.join(root, "local") };
      const remote = { CODEXHOST_DATA_DIR: path.join(root, "remote") };
      const localId = await consoleBuildId(entry, local);
      expect(await consoleBuildId(entry, remote)).not.toBe(localId);
      expect(await consoleBuildId(entry, local)).toBe(localId);
      expect(
        await consoleBuildId(entry, {
          CODEXHOST_DATA_DIR: path.join(root, "local", "child", ".."),
        }),
      ).toBe(localId);
      expect(await consoleBuildId(entry, {})).toBe(
        await consoleBuildId(entry, {
          CODEXHOST_DATA_DIR: path.join(os.homedir(), ".codexhost"),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
