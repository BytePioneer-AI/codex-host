#!/usr/bin/env node
// Synthetic JSON-RPC peer for the official SDK process-transport tests.
let buffer = Buffer.alloc(0);
const send = (id, result) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length:\s*(\d+)/i)?.[1],
    );
    if (buffer.length < end + 4 + length) return;
    const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (request.id === undefined) continue;
    if (request.method === "connect") send(request.id, { protocolVersion: 3 });
    else if (request.method === "ping")
      send(request.id, {
        protocolVersion: 3,
        message: JSON.stringify({
          cwd: process.cwd(),
          arguments: process.argv.slice(2),
          marker: process.env.CODEXHOST_COPILOT_TEST_MARKER,
          deleted: process.env.CODEXHOST_COPILOT_TEST_DELETE === undefined,
          home: process.env.HOME,
          config: process.env.COPILOT_HOME,
          keychainDisabled: process.env.COPILOT_DISABLE_KEYTAR !== undefined,
        }),
      });
    else if (request.method === "runtime.shutdown") {
      send(request.id, {});
      setTimeout(() => process.exit(0), 10);
    } else {
      send(request.id, {});
    }
  }
});
