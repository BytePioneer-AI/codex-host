import type { Duplex } from "node:stream";

const maxHelloSize = 16 * 1024;

export interface ClientHello {
  servername: string;
  alpn: string[];
}

function extensions(hello: Buffer): ClientHello {
  let offset = 4 + 2 + 32;
  offset += 1 + hello.readUInt8(offset);
  offset += 2 + hello.readUInt16BE(offset);
  offset += 1 + hello.readUInt8(offset);
  const end = offset + 2 + hello.readUInt16BE(offset);
  offset += 2;
  let servername = "";
  const alpn: string[] = [];
  while (offset < end) {
    const type = hello.readUInt16BE(offset);
    const length = hello.readUInt16BE(offset + 2);
    offset += 4;
    const next = offset + length;
    if (next > hello.length) throw new Error("Invalid ClientHello extension");
    if (type === 0) {
      let cursor = offset + 2;
      while (cursor < next) {
        const nameType = hello.readUInt8(cursor);
        const size = hello.readUInt16BE(cursor + 1);
        cursor += 3;
        if (cursor + size > next) throw new Error("Invalid SNI");
        if (nameType === 0) servername = hello.toString("ascii", cursor, cursor + size);
        cursor += size;
      }
    } else if (type === 16) {
      let cursor = offset + 2;
      while (cursor < next) {
        const size = hello.readUInt8(cursor++);
        if (cursor + size > next) throw new Error("Invalid ALPN");
        alpn.push(hello.toString("ascii", cursor, cursor + size));
        cursor += size;
      }
    }
    offset = next;
  }
  if (end !== hello.length || !servername) throw new Error("Missing SNI or invalid ClientHello");
  return { servername, alpn };
}

export function parseClientHello(bytes: Buffer): ClientHello | undefined {
  let offset = 0;
  let length = 0;
  const fragments: Buffer[] = [];
  while (offset + 5 <= bytes.length) {
    if (bytes[offset] !== 22) throw new Error("Expected TLS handshake record");
    const recordEnd = offset + 5 + bytes.readUInt16BE(offset + 3);
    if (recordEnd > maxHelloSize) throw new Error("ClientHello exceeds 16 KiB");
    if (recordEnd > bytes.length) return;
    const fragment = bytes.subarray(offset + 5, recordEnd);
    fragments.push(fragment);
    length += fragment.length;
    const hello = Buffer.concat(fragments, length);
    if (hello.length >= 4) {
      if (hello[0] !== 1) throw new Error("Expected ClientHello");
      const helloLength = 4 + hello.readUIntBE(1, 3);
      if (helloLength > maxHelloSize - 5) throw new Error("ClientHello exceeds 16 KiB");
      if (hello.length >= helloLength) return extensions(hello.subarray(0, helloLength));
    }
    offset = recordEnd;
  }
  if (bytes.length >= maxHelloSize) throw new Error("ClientHello exceeds 16 KiB");
}

/** Leaves the socket paused with every inspected byte restored to its readable queue. */
export function readClientHello(socket: Duplex): Promise<ClientHello> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error("ClientHello timed out")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("readable", read);
      socket.off("error", fail);
      socket.off("end", ended);
      socket.off("close", ended);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const ended = () => fail(new Error("Connection closed during ClientHello"));
    const read = () => {
      const chunk = socket.read(Math.min(socket.readableLength, maxHelloSize - bytes.length));
      if (!chunk) return;
      bytes = Buffer.concat([bytes, chunk]);
      try {
        const hello = parseClientHello(bytes);
        if (!hello) return;
        cleanup();
        socket.unshift(bytes);
        resolve(hello);
      } catch (error) {
        fail(error as Error);
      }
    };
    socket.on("readable", read);
    socket.once("error", fail);
    socket.once("end", ended);
    socket.once("close", ended);
    read();
  });
}
