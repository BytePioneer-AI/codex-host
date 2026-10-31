import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { startServer } = createRequire(import.meta.url)("../assets/companion/server.cjs");

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-bridge-"));
  const service = {
    application: { name: "Trae CN", version: "fixture" },
    workspaceFolders: ["/workspace"],
    inspect: vi.fn(async () => ({ models: [{ id: "configured", label: "Configured" }] })),
    call: vi.fn(async () => ({ sessionId: "session" })),
    subscribe: vi.fn(),
  };
  const bridge = await startServer(service, directory);
  const url = `http://127.0.0.1:${bridge.endpoint.port}`;
  const headers = {
    authorization: `Bearer ${bridge.endpoint.token}`,
    "content-type": "application/json",
  };
  return {
    service,
    bridge,
    directory,
    url,
    headers,
    async close() {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("TRAE CN local companion transport", () => {
  it("publishes a discoverable instance and rejects missing credentials and browser origins", async () => {
    const test = await setup();
    try {
      const metadata = JSON.parse(await readFile(test.bridge.endpointFile, "utf8"));
      expect(metadata).toMatchObject({
        protocolVersion: 1,
        pid: process.pid,
        workspaceFolders: ["/workspace"],
      });
      expect(
        (
          await fetch(`${test.url}/inspect`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${test.url}/inspect`, {
            method: "POST",
            headers: { ...test.headers, origin: "https://untrusted.invalid" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(test.service.inspect).not.toHaveBeenCalled();
      const response = await fetch(`${test.url}/inspect`, {
        method: "POST",
        headers: test.headers,
        body: "{}",
      });
      expect(await response.json()).toMatchObject({
        ok: true,
        value: { instanceId: metadata.instanceId, models: [{ id: "configured" }] },
      });
    } finally {
      await test.close();
    }
  });

  it("does not pass invalid JSON or unknown endpoints to the native service", async () => {
    const test = await setup();
    try {
      expect(
        (await fetch(`${test.url}/call`, { method: "POST", headers: test.headers, body: "{" }))
          .status,
      ).toBe(400);
      expect(
        (
          await fetch(`${test.url}/raw-native-rpc`, {
            method: "POST",
            headers: test.headers,
            body: "{}",
          })
        ).status,
      ).toBe(404);
      expect(test.service.call).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("streams immediate native events and closes subscriptions when the observer ends", async () => {
    const test = await setup();
    const cancel = vi.fn();
    test.service.subscribe.mockImplementation(async (_input, listener) => {
      listener.data({ event: "done", payload: { status: "completed" } });
      listener.end();
      return cancel;
    });
    try {
      const response = await fetch(`${test.url}/subscribe`, {
        method: "POST",
        headers: test.headers,
        body: '{"sessionId":"session"}',
      });
      const lines = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual([
        { type: "event", value: { event: "done", payload: { status: "completed" } } },
        { type: "end" },
      ]);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await test.close();
    }
  });

  it("omits embedded native account/config details from error responses", async () => {
    const test = await setup();
    test.service.call.mockRejectedValue(
      Object.assign(new Error('Native configuration failed: {"token":"fixture-private-token"}'), {
        code: "nativeFailure",
      }),
    );
    try {
      const response = await fetch(`${test.url}/call`, {
        method: "POST",
        headers: test.headers,
        body: '{"method":"snapshot","input":{"sessionId":"session"}}',
      });
      const output = await response.text();
      expect(output).not.toContain("fixture-private-token");
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        error: { code: "nativeFailure", message: "Native configuration failed: " },
      });
    } finally {
      await test.close();
    }
  });

  it("removes only its own discovery file on shutdown", async () => {
    const test = await setup();
    try {
      await test.bridge.close();
      expect(await readdir(test.directory)).toEqual([]);
      await test.bridge.close();
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });
});
