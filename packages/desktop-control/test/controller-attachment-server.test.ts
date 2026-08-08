import { createConnection, createServer } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { startControllerAttachmentServer } from "../src/controller-attachment-server.js";

const nonce = "0123456789abcdef0123456789abcdef";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP address unavailable");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function request(port: number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("connect", () => socket.write(line));
  });
}

describe("Controller attachment server", () => {
  it("accepts only the exact nonce and invokes the attachment callback", async () => {
    const port = await availablePort();
    const attach = vi.fn(async () => {});
    const compatibilityUpdate = vi.fn(async () => "current" as const);
    const shutdown = vi.fn(async () => {});
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach,
      compatibilityUpdate,
      shutdown,
    });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
      await expect(request(port, `ATTACH ${"0".repeat(32)}\n`)).resolves.toBe("rejected\n");
      expect(attach).toHaveBeenCalledOnce();
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("runs only the authenticated fixed compatibility update operation", async () => {
    const port = await availablePort();
    const compatibilityUpdate = vi.fn(async () => "update-started" as const);
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
      compatibilityUpdate,
      shutdown: async () => {},
    });
    try {
      await expect(request(port, `COMPATIBILITY_UPDATE ${nonce}\n`)).resolves.toBe(
        "update-started\n",
      );
      await expect(request(port, `COMPATIBILITY_UPDATE ${"0".repeat(32)}\n`)).resolves.toBe(
        "rejected\n",
      );
      expect(compatibilityUpdate).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("reports callback failure without exposing its error", async () => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {
        throw new Error("private detail");
      },
      compatibilityUpdate: async () => "unavailable",
      shutdown: async () => {},
    });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("failed\n");
    } finally {
      await server.close();
    }
  });

  it("acknowledges an authenticated shutdown before invoking its callback", async () => {
    const port = await availablePort();
    const events: string[] = [];
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
      compatibilityUpdate: async () => "unavailable",
      shutdown: async () => {
        events.push("shutdown");
      },
    });
    try {
      await expect(request(port, `SHUTDOWN ${nonce}\n`)).resolves.toBe("ready\n");
      events.unshift("response");
      await vi.waitFor(() => expect(events).toEqual(["response", "shutdown"]));
      await expect(request(port, `SHUTDOWN ${"0".repeat(32)}\n`)).resolves.toBe("rejected\n");
    } finally {
      await server.close();
    }
  });
});
