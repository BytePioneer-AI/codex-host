import { createServer } from "node:net";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { startControllerAttachmentServer } from "../src/controller-attachment-server.js";
import {
  remoteConnectionsExpression,
  requestDesktopRemoteConnections,
} from "../src/remote-connections-control.js";

const nonce = "0123456789abcdef0123456789abcdef";
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("remote settings Controller channel", () => {
  it("authenticates requests, rejects unknown operations, and preserves remote error codes", async () => {
    const port = await availablePort();
    const remoteConnections = vi.fn(async () => ({
      error: { code: -32601, message: "Remote runtime unsupported" },
    }));
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
      remoteConnections,
    });
    const environment = { CODEXHOST_CONTROL_PORT: String(port), CODEXHOST_CONTROL_NONCE: nonce };
    try {
      await expect(
        requestDesktopRemoteConnections(environment, { action: "runtime", hostId: "office" }),
      ).resolves.toEqual({ error: { code: -32601, message: "Remote runtime unsupported" } });
      expect(remoteConnections).toHaveBeenCalledWith({ action: "runtime", hostId: "office" });
      await expect(
        requestDesktopRemoteConnections(
          { ...environment, CODEXHOST_CONTROL_NONCE: "0".repeat(32) },
          { action: "list" },
        ),
      ).resolves.toMatchObject({ error: { code: -32090 } });
      await expect(
        requestDesktopRemoteConnections(environment, { action: "eval", expression: "anything" }),
      ).resolves.toMatchObject({ error: { code: -32602 } });
      await expect(
        requestDesktopRemoteConnections(environment, {
          action: "update",
          hostId: "local",
          version: "0.12.0",
        }),
      ).resolves.toMatchObject({ error: { code: -32602 } });
      expect(remoteConnections).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it.each([2, 17])("handles a %i MiB Thread reply with an explicit byte contract", async (mib) => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
      remoteConnections: async () => ({ result: { text: "x".repeat(mib * 1024 * 1024) } }),
    });
    try {
      const reply = await requestDesktopRemoteConnections(
        { CODEXHOST_CONTROL_PORT: String(port), CODEXHOST_CONTROL_NONCE: nonce },
        { action: "read-thread", hostId: "mac", input: { threadId: "t", view: "result" } },
      );
      if (mib === 2)
        expect(reply).toMatchObject({ result: { text: expect.stringMatching(/^x+$/u) } });
      else
        expect(reply).toMatchObject({
          error: { code: -32094, message: expect.stringContaining("16 MiB") },
        });
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    "counts fragmented UTF-8 replies before appending (oversized=%s)",
    async (oversized) => {
      const text = "界🙂".repeat(oversized ? 160_000 : 100);
      const bytes = Buffer.from(JSON.stringify({ result: { text } }) + "\n");
      const server = createServer((socket) => {
        socket.on("error", () => {});
        socket.once("data", () => {
          let offset = 0;
          const send = (): void => {
            if (socket.destroyed) return;
            if (offset >= bytes.length) {
              socket.end();
              return;
            }
            // Deliberately split inside multi-byte code points.
            const next = Math.min(offset + (oversized ? 4093 : 5), bytes.length);
            socket.write(bytes.subarray(offset, next), () => setImmediate(send));
            offset = next;
          };
          send();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      try {
        const reply = await requestDesktopRemoteConnections(
          { CODEXHOST_CONTROL_PORT: String(address.port), CODEXHOST_CONTROL_NONCE: nonce },
          { action: "list" },
        );
        if (oversized) expect(reply).toMatchObject({ error: { code: -32094 } });
        else expect(reply).toEqual({ result: { text } });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("does not replay a mutation after a timeout", async () => {
    const port = await availablePort();
    const pending = Promise.withResolvers<{ result: null }>();
    const remoteConnections = vi.fn(() => pending.promise);
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
      remoteConnections,
    });
    try {
      await expect(
        requestDesktopRemoteConnections(
          { CODEXHOST_CONTROL_PORT: String(port), CODEXHOST_CONTROL_NONCE: nonce },
          { action: "connect", hostId: "office", enabled: false },
          100,
        ),
      ).resolves.toMatchObject({ error: { code: -32093 } });
      expect(remoteConnections).toHaveBeenCalledOnce();
    } finally {
      pending.resolve({ result: null });
      await server.close();
    }
  });

  it("passes user text as data and returns an actionable error for old Renderers", async () => {
    const request = {
      action: "state" as const,
      hostId: 'office\"); throw new Error("injected");//',
    };
    const remoteConnections = vi.fn(async () => ({ state: "connected", error: null }));
    await expect(
      runInNewContext(remoteConnectionsExpression(request), {
        window: { __codexhostRendererBindingProbeV1: { remoteConnections } },
      }),
    ).resolves.toEqual({ result: { state: "connected", error: null } });
    expect(remoteConnections).toHaveBeenCalledWith(request);
    await expect(
      runInNewContext(remoteConnectionsExpression({ action: "list" }), { window: {} }),
    ).resolves.toMatchObject({
      error: { code: -32090, message: expect.stringContaining("Restart Codex through codexhost") },
    });
    await expect(requestDesktopRemoteConnections({}, { action: "list" })).resolves.toMatchObject({
      error: { code: -32090 },
    });
  });
});
