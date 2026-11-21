import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { createInterface } from "node:readline";
import { expect, it, vi } from "vitest";
import { startControllerAttachmentServer } from "../src/controller-attachment-server.js";
import { controllerLifecycle } from "../src/controller-lifecycle.js";

it("proves the Controller identity and accepts shutdown only with a fresh client proof", async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const { port } = address;
  probe.close();
  await once(probe, "close");
  const key = Buffer.alloc(32, 42);
  const context = "a".repeat(32);
  const client = "b".repeat(32);
  const attach = vi.fn(async () => {});
  const stop = vi.fn();
  const server = await startControllerAttachmentServer({
    port,
    nonce: "c".repeat(32),
    attach,
    lifecycle: controllerLifecycle(key, context, stop),
  });
  async function connection() {
    const socket = createConnection({ host: "127.0.0.1", port });
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    await once(socket, "connect");
    socket.write(`LIFECYCLE 1 ${client}\n`);
    const [kind, challenge, serverProof] = String((await lines.next()).value).split(" ");
    const proof = (role: string) =>
      createHmac("sha256", key)
        .update(`${role}:${context}:${process.pid}:${client}:${challenge}`)
        .digest("hex");
    expect(kind).toBe("identity");
    expect(challenge).toMatch(/^[0-9a-f]{32}$/u);
    expect(serverProof).toBe(proof("identity"));
    return { socket, lines, challenge, proof, serverProof };
  }
  try {
    const first = await connection();
    first.socket.write(`stop ${first.serverProof}\n`);
    expect((await first.lines.next()).value).toBe("rejected");
    expect(stop).not.toHaveBeenCalled();
    const second = await connection();
    expect(second.challenge).not.toBe(first.challenge);
    second.socket.write(`stop ${first.proof("stop")}\n`);
    expect((await second.lines.next()).value).toBe("rejected");
    expect(stop).not.toHaveBeenCalled();
    const verified = await connection();
    verified.socket.write(`stop ${verified.proof("stop")}\n`);
    expect((await verified.lines.next()).value).toBe("stopping");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(attach).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
