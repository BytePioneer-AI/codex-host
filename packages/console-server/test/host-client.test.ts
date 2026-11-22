import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsoleHostClient, findHost } from "../src/host-client.js";

let directory: string;

async function descriptor(
  pid: number,
  port: number,
  startedAt: number,
  runtimePath?: string,
): Promise<string> {
  const token = String(pid % 10).repeat(64);
  await writeFile(
    path.join(directory, `host-${pid}.json`),
    JSON.stringify({ schemaVersion: 1, pid, port, token, startedAt, runtimePath }),
  );
  return token;
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-hosts-"));
  await mkdir(directory, { recursive: true });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("console Host client", () => {
  it.each(["matching", "other", "unknown"])(
    "checks the %s installation before forwarding updates",
    async (kind) => {
      const appDirectory = path.join(directory, "app");
      const other = path.join(directory, "other-app");
      await Promise.all([mkdir(appDirectory), mkdir(other)]);
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.end(JSON.stringify({ result: { status: null } }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await descriptor(
          14,
          (server.address() as AddressInfo).port,
          1,
          kind === "unknown"
            ? undefined
            : path.join(kind === "matching" ? appDirectory : other, "host-runtime.mjs"),
        );
        const client = createConsoleHostClient(directory, {
          isAlive: () => true,
          updateAppDirectory: appDirectory,
        });
        if (kind === "matching") {
          await expect(client.request("codexhost/update/status", {})).resolves.toEqual({
            result: { status: null },
          });
          expect(requests).toBe(1);
        } else {
          await expect(client.request("codexhost/update/start", {})).rejects.toThrow(
            kind === "other"
              ? "different codexhost installation"
              : "does not identify its installation",
          );
          expect(requests).toBe(0);
        }
      } finally {
        server.close();
      }
    },
  );
  it("picks the newest live Host and removes descriptors of exited Hosts", async () => {
    await descriptor(11, 1001, 1);
    await descriptor(12, 1002, 3);
    await descriptor(13, 1003, 5);
    const host = await findHost(directory, (pid) => pid !== 13);
    expect(host?.pid).toBe(12);
    expect((await readdir(directory)).sort()).toEqual(["host-11.json", "host-12.json"]);
  });

  it("forwards a request with the Host token", async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.end(JSON.stringify({ result: { ok: true } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const token = await descriptor(14, (server.address() as AddressInfo).port, 1);
      const client = createConsoleHostClient(directory, { isAlive: () => true });
      await expect(client.request("codexhost/account/list", {})).resolves.toEqual({
        result: { ok: true },
      });
      expect(authorization).toBe(`Bearer ${token}`);
    } finally {
      server.close();
    }
  });

  it("reports no Host when none published a channel", async () => {
    const client = createConsoleHostClient(path.join(directory, "missing"));
    expect(await client.available()).toBe(false);
    await expect(client.request("codexhost/account/list", {})).rejects.toThrow("not running");
  });
});
