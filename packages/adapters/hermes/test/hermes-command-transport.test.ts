import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HermesAcpTransport, type HermesTransportEvent } from "../src/acp-transport.js";

// Real stdio framing verifies that command advertisements are retained outside
// an active prompt, including advertisements delivered before newSession resolves.
describe("Hermes ACP command negotiation", () => {
  it.skipIf(process.platform === "win32").each([1, 999])(
    "dispatches native commands when the ACP peer reports protocol version %i",
    async (protocolVersion) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "hermes-command-protocol-"));
      const command = path.join(root, "hermes");
      await writeFile(
        command,
        `#!/usr/bin/env node
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (value) => send({ method: "session/update", params: { sessionId: "native", update: value } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  let result;
  if (request.method === "initialize") result = { protocolVersion: ${protocolVersion}, agentCapabilities: { loadSession: true } };
  else if (request.method === "session/new") {
    update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compress", description: "Compress context" }] });
    result = { sessionId: "native" };
  } else if (request.method === "session/prompt") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: request.params.prompt[0].text === "/compress" ? "Nothing to compress — conversation is empty." : "unexpected" } });
    result = { stopReason: "end_turn" };
  } else result = {};
  if (request.id !== undefined) send({ id: request.id, result });
});
`,
      );
      await chmod(command, 0o755);
      const transport = new HermesAcpTransport({ cwd: root, command, closeTimeoutMs: 100 });
      try {
        expect(transport.availableCommands).toEqual([]);
        await transport.open({ kind: "create" });
        expect(transport.availableCommands).toEqual([
          { name: "compress", description: "Compress context" },
        ]);
        const events: HermesTransportEvent[] = [];
        expect(
          await transport.runTurn(
            "/compress",
            (event) => events.push(event),
            async () => ({ outcome: { outcome: "cancelled" } }),
          ),
        ).toMatchObject({ stopReason: "end_turn" });
        expect(events).toEqual([
          { type: "agent.text", text: "Nothing to compress — conversation is empty." },
        ]);
      } finally {
        await transport.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
