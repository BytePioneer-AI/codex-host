import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { connect } from "node:tls";
import { describe, expect, it } from "vitest";
import { parseClientHello, readClientHello } from "../src/client-hello.js";

async function capture(servername?: string, alpn = ["h2", "http/1.1"]): Promise<Buffer> {
  const server = createServer();
  server.listen(4481, "127.0.0.1");
  await once(server, "listening");
  const accepted = once(server, "connection");
  const client = connect({
    host: "127.0.0.1",
    port: 4481,
    servername,
    ALPNProtocols: alpn,
    rejectUnauthorized: false,
  });
  client.on("error", () => {});
  const [socket] = await accepted;
  const [data] = await once(socket, "data");
  client.destroy();
  socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return data;
}

describe("ClientHello", () => {
  it("reads a real TLS ClientHello one byte at a time without consuming it", async () => {
    const bytes = await capture("Phone.Example");
    const socket = new PassThrough();
    const parsed = readClientHello(socket as unknown as Socket);
    for (const byte of bytes) {
      socket.write(Buffer.from([byte]));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await parsed).toEqual({ servername: "Phone.Example", alpn: ["h2", "http/1.1"] });
    expect(socket.read()).toEqual(bytes);
    socket.destroy();
  });

  it("joins handshake fragments across TLS records, including a split handshake header", async () => {
    const original = await capture("phone.example", ["acme-tls/1"]);
    const payload = original.subarray(5);
    const records = [payload.subarray(0, 2), payload.subarray(2, 77), payload.subarray(77)].map(
      (part) => {
        const header = Buffer.from([22, 3, 1, 0, 0]);
        header.writeUInt16BE(part.length, 3);
        return Buffer.concat([header, part]);
      },
    );
    const bytes = Buffer.concat(records);
    for (let size = 0; size < bytes.length; size++)
      expect(parseClientHello(bytes.subarray(0, size))).toBeUndefined();
    expect(parseClientHello(bytes)).toEqual({ servername: "phone.example", alpn: ["acme-tls/1"] });
  });

  it("rejects missing SNI and oversized or malformed handshakes", async () => {
    const noSni = await capture();
    expect(() => parseClientHello(noSni)).toThrow();
    expect(() => parseClientHello(Buffer.from([22, 3, 1, 64, 0]))).toThrow("16 KiB");
    const invalid = await capture("phone.example");
    invalid[5] = 2;
    expect(() => parseClientHello(invalid)).toThrow("Expected ClientHello");
  });

  it("rejects a socket that has not completed its hello in ten seconds", async () => {
    const socket = new PassThrough();
    await expect(readClientHello(socket as unknown as Socket)).rejects.toThrow("timed out");
    socket.destroy();
  }, 12_000);
});
