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
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach,
    });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
      await expect(request(port, `ATTACH ${"0".repeat(32)}\n`)).resolves.toBe("rejected\n");
      expect(attach).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("stops accepting connections before waiting for open pages to close", async () => {
    const port = await availablePort();
    const released = Promise.withResolvers<undefined>();
    const close = vi.fn(async () => released.promise);
    const openLocalPage = vi.fn(async () => ({ show: async () => {}, close }));
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: vi.fn(),
      openLocalPage,
    });
    const page = createConnection({ host: "127.0.0.1", port });
    page.on("error", () => {});
    page.write(`PAGE ${nonce} http://127.0.0.1:12345/\n`);
    await vi.waitFor(() => expect(openLocalPage).toHaveBeenCalledOnce());
    const closing = server.close();
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      await expect(request(port, `ATTACH ${nonce}\n`)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    } finally {
      released.resolve(undefined);
      await closing;
    }
  });

  it("keeps attachment recovery single-flight while duplicate launchers retry", async () => {
    const port = await availablePort();
    const recovery = Promise.withResolvers<undefined>();
    const attach = vi.fn(async () => recovery.promise);
    const server = await startControllerAttachmentServer({ port, nonce, attach });
    try {
      const first = request(port, `ATTACH ${nonce}\n`);
      await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());

      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("busy\n");
      expect(attach).toHaveBeenCalledOnce();

      recovery.resolve(undefined);
      await expect(first).resolves.toBe("ready\n");
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
      expect(attach).toHaveBeenCalledTimes(2);
    } finally {
      recovery.resolve(undefined);
      await server.close();
    }
  });

  it("keeps recovery alive after its client disconnects and accepts later attachments", async () => {
    const port = await availablePort();
    const recovery = Promise.withResolvers<undefined>();
    const attach = vi.fn(async () => recovery.promise);
    const server = await startControllerAttachmentServer({ port, nonce, attach });
    const first = createConnection({ host: "127.0.0.1", port });
    try {
      await new Promise<void>((resolve, reject) => {
        first.once("error", reject);
        first.once("connect", () => {
          first.write(`ATTACH ${nonce}\n`);
          resolve();
        });
      });
      await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => {
        first.once("close", () => resolve());
        first.destroy();
      });

      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("busy\n");
      expect(attach).toHaveBeenCalledOnce();

      recovery.resolve(undefined);
      await vi.waitFor(async () => {
        await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
      });
      expect(attach).toHaveBeenCalledTimes(2);
    } finally {
      first.destroy();
      recovery.resolve(undefined);
      await server.close();
    }
  });

  it("releases a failed attachment so a later retry can recover", async () => {
    const port = await availablePort();
    const attach = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("recovery failed"))
      .mockResolvedValueOnce(undefined);
    const server = await startControllerAttachmentServer({ port, nonce, attach });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("failed\n");
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("ready\n");
      expect(attach).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("rejects the retired compatibility update command", async () => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
    });
    try {
      await expect(request(port, `COMPATIBILITY_UPDATE ${nonce}\n`)).resolves.toBe("rejected\n");
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
    });
    try {
      await expect(request(port, `ATTACH ${nonce}\n`)).resolves.toBe("failed\n");
    } finally {
      await server.close();
    }
  });

  it("rejects the retired Desktop quit command", async () => {
    const port = await availablePort();
    const server = await startControllerAttachmentServer({
      port,
      nonce,
      attach: async () => {},
    });
    try {
      await expect(request(port, `SHUTDOWN ${nonce}\n`)).resolves.toBe("rejected\n");
    } finally {
      await server.close();
    }
  });
});
