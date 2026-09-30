import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  consoleHostDescriptorDirectory,
  startConsoleControlServer,
  type ConsoleHostDescriptor,
} from "../src/console-control-server.js";

let dataDirectory: string;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-control-"));
});

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("Host console channel", () => {
  it("publishes a private descriptor and forwards authorized requests", async () => {
    const target = {
      handleConsoleRequest: vi.fn(async (method: string) => ({ result: { method } })),
    };
    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    const server = await startConsoleControlServer({ target, environment, pid: 4242 });
    try {
      expect(server.descriptorPath).toBe(
        path.join(consoleHostDescriptorDirectory(environment), "host-4242.json"),
      );
      const descriptor = JSON.parse(
        await readFile(server.descriptorPath, "utf8"),
      ) as ConsoleHostDescriptor;
      expect(descriptor).toMatchObject({ schemaVersion: 1, pid: 4242 });
      if (process.platform !== "win32") {
        expect((await stat(server.descriptorPath)).mode & 0o777).toBe(0o600);
      }
      const url = `http://127.0.0.1:${descriptor.port}/rpc`;
      const body = JSON.stringify({ method: "codexhost/account/list", params: {} });

      expect((await fetch(url, { method: "POST", body })).status).toBe(401);
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${"0".repeat(64)}` },
            body,
          })
        ).status,
      ).toBe(401);
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${descriptor.token}` },
        body,
      });
      expect(await response.json()).toEqual({ result: { method: "codexhost/account/list" } });
      expect(target.handleConsoleRequest).toHaveBeenCalledWith("codexhost/account/list", {});
    } finally {
      await server.close();
    }
    await expect(stat(server.descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
