import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsoleHostClient, findHost } from "../src/host-client.js";

let directory: string;

async function descriptor(pid: number, port: number, startedAt: number): Promise<string> {
  const token = String(pid % 10).repeat(64);
  await writeFile(
    path.join(directory, `host-${pid}.json`),
    JSON.stringify({ schemaVersion: 1, pid, port, token, startedAt }),
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
  it("picks the newest live Host and removes descriptors of exited Hosts", async () => {
    await descriptor(11, 1001, 1);
    await descriptor(12, 1002, 3);
    await descriptor(13, 1003, 5);
    const host = await findHost(directory, (pid) => pid !== 13);
    expect(host?.pid).toBe(12);
    expect((await readdir(directory)).sort()).toEqual(["host-11.json", "host-12.json"]);
  });

  it("scopes update routing to this installation, not another or legacy newest Host", async () => {
    const own = path.join(directory, "own"),
      other = path.join(directory, "other");
    await mkdir(own);
    await mkdir(other);
    for (const [pid, resourcesRoot, startedAt] of [
      [21, own, 1],
      [22, other, 2],
    ] as const) {
      await writeFile(
        path.join(directory, `host-${pid}.json`),
        JSON.stringify({
          schemaVersion: 1,
          pid,
          port: 1000 + pid,
          token: "a".repeat(64),
          startedAt,
          resourcesRoot,
          launcherPid: pid + 100,
        }),
      );
    }
    await descriptor(23, 1023, 3);
    expect((await findHost(directory, () => true, own))?.pid).toBe(21);
    expect((await findHost(directory, () => true, other))?.pid).toBe(22);
    expect((await findHost(directory, () => true, own, 121))?.pid).toBe(21);
    expect(await findHost(directory, () => true, own, 122)).toBeNull();
    expect(
      await createConsoleHostClient(directory, {
        isAlive: () => true,
        resourcesRoot: path.join(directory, "missing"),
      }).available(),
    ).toBe(false);
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
