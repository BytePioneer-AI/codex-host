import { createHash, createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type * as FileSystemPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { desktopCookieSigner, resolveDesktopEndpoint } from "../src/desktop-connection.js";
import { ModernRemoteConnection } from "../src/modern/remote-connection.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const endpoint = "http://127.0.0.1:19387/";
const secret = Buffer.alloc(32, 7);
let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "codexhost-dsh-desktop-"));
  await writeGrant();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});
async function writeGrant(payload: unknown = { version: 1, secret: secret.toString("base64url") }) {
  await writeFile(
    path.join(home, ".credentials.yaml"),
    stringify({
      version: 1,
      records: { "client-connection/browser-session": { kind: "grant", payload } },
    }),
    { mode: 0o600 },
  );
}

describe("DeepSeek Desktop connection", () => {
  it("recognizes a Desktop CLI resolved with Windows path separators", async () => {
    vi.mocked(realpath).mockResolvedValueOnce(
      String.raw`C:\Apps\DeepSeek Harness.app\Contents\Resources\runtime\cli\bin\dsh`,
    );
    expect(await resolveDesktopEndpoint("dsh")).toBe(endpoint);
  });

  it("recognizes the Desktop-installed CLI through its symlink and respects web override", async () => {
    const cli = path.join(home, "DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh");
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "");
    const link = path.join(home, "dsh");
    await symlink(cli, link);
    expect(await resolveDesktopEndpoint(link)).toBe(endpoint);
    expect(await resolveDesktopEndpoint(link, "web")).toBeUndefined();
    expect(await resolveDesktopEndpoint(cli, "auto", "http://127.0.0.1:1234/")).toBe(
      "http://127.0.0.1:1234/",
    );
    expect(await resolveDesktopEndpoint("missing")).toBeUndefined();
    expect(await resolveDesktopEndpoint("missing", "desktop")).toBe(endpoint);
  });

  it("rejects remote endpoints and invalid connection modes", async () => {
    await expect(resolveDesktopEndpoint("dsh", "desktop", "https://example.com/")).rejects.toThrow(
      "loopback",
    );
    await expect(
      resolveDesktopEndpoint("dsh", "desktop", "http://127.0.0.1:19387/?token=secret"),
    ).rejects.toThrow("bootstrap");
    await expect(resolveDesktopEndpoint("dsh", "invalid" as "auto")).rejects.toThrow("mode");
  });

  it("signs the native authority-bound cookie and renews it without changing the grant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const signer = await desktopCookieSigner(endpoint, { DSH_HOME: home });
    const cookie = signer();
    const name = `dsh-auth-${createHash("sha256").update("127.0.0.1:19387").digest("base64url")}`;
    const [version, body, signature] = cookie.slice(name.length + 1).split(".");
    expect(version).toBe("v1");
    expect(JSON.parse(Buffer.from(body ?? "", "base64url").toString())).toEqual({
      version: 1,
      authority: "127.0.0.1:19387",
      issuedAt: 1_000_000,
      expiresAt: 4_600_000,
    });
    expect(signature).toBe(
      createHmac("sha256", secret)
        .update(body ?? "")
        .digest("base64url"),
    );
    vi.setSystemTime(5_000_000);
    expect(signer()).not.toBe(cookie);
  });

  it.each([
    {},
    { version: 2, secret: secret.toString("base64url") },
    { version: 1, secret: "bad" },
  ])("rejects unsupported grants without exposing their contents", async (payload) => {
    await writeGrant(payload);
    await expect(desktopCookieSigner(endpoint, { DSH_HOME: home })).rejects.toThrow("grant");
  });

  it.skipIf(process.platform === "win32")(
    "rejects credentials readable by other users",
    async () => {
      await chmod(path.join(home, ".credentials.yaml"), 0o644);
      await expect(desktopCookieSigner(endpoint, { DSH_HOME: home })).rejects.toThrow("owner-only");
    },
  );

  it("uses the existing Host for native RPC and closes without spawning or killing a process", async () => {
    const spawn = vi.fn();
    const killProcessTree = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "server-response",
            rpcId: "desktop-rpc",
            result: { ok: true, value: { native: true } },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const connection = new ModernRemoteConnection(
      { command: "dsh", desktopEndpoint: endpoint, environment: { DSH_HOME: home } },
      { spawn, fetch, killProcessTree, randomUUID: () => "desktop-rpc" },
    );
    try {
      await connection.connect();
      expect(await connection.call("session/modelCatalog", {})).toEqual({
        ok: true,
        value: { native: true },
      });
      expect(fetch.mock.calls[1]?.[0].href).toBe(`${endpoint}api/session/modelCatalog`);
      expect(fetch.mock.calls[1]?.[1].headers.cookie).toMatch(/^dsh-auth-/);
    } finally {
      await connection.close();
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it("reports rejected Desktop authentication without silently starting Web", async () => {
    const spawn = vi.fn();
    const connection = new ModernRemoteConnection(
      { command: "dsh", desktopEndpoint: endpoint, environment: { DSH_HOME: home } },
      { spawn, fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })) },
    );
    try {
      await expect(connection.connect()).rejects.toMatchObject({ code: "authenticationRequired" });
    } finally {
      await connection.close();
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["http", "https"])(
    "uses the matching WebSocket protocol for a %s Desktop endpoint",
    async (protocol) => {
      const createWebSocket = vi.fn(() => {
        throw new Error("stop after capturing the handshake URL");
      });
      const connection = new ModernRemoteConnection(
        {
          command: "dsh",
          desktopEndpoint: `${protocol}://127.0.0.1:19387/`,
          environment: { DSH_HOME: home },
        },
        { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })), createWebSocket },
      );
      try {
        await expect(
          connection.openStream("$events", {})[Symbol.asyncIterator]().next(),
        ).rejects.toThrow();
        expect(createWebSocket).toHaveBeenCalledWith(
          new URL(`${protocol === "https" ? "wss" : "ws"}://127.0.0.1:19387/api/remote.mux`),
          expect.stringMatching(/^dsh-auth-/),
          expect.any(Number),
        );
      } finally {
        await connection.close();
      }
    },
  );
});
