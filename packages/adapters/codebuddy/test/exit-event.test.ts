import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import { CodeBuddyAcpClient } from "../src/acp-client.js";
const state = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => state.child, execFile: vi.fn() }));
vi.mock("../src/command.js", () => ({
  codeBuddyInvocation: () => ({ command: "fixture", arguments: [], environment: {} }),
}));
describe("CodeBuddy independent process exit signal", () => {
  it("rejects a pending prompt before close or EOF when the native process exits", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    });
    state.child = child;
    child.stdin.on("data", (chunk) => {
      const m = JSON.parse(String(chunk));
      if (m.method === "session/prompt") return;
      const result =
        m.method === "initialize"
          ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
          : { sessionId: "native" };
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    });
    const fault = vi.fn(),
      update = vi.fn(),
      client = new CodeBuddyAcpClient({
        cwd: process.cwd(),
        environment: {},
        ephemeral: false,
        handlers: { update, permission: vi.fn(), question: vi.fn(), fault },
      });
    try {
      await client.initialize();
      await client.open(process.cwd());
      const rejected = vi.fn();
      const prompt = client.prompt("native", "pending").catch(rejected);
      child.exitCode = 1;
      child.emit("exit", 1, null);
      const notification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "native",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "buffered before EOF" },
          },
        },
      };
      child.stdout.write(JSON.stringify(notification) + "\n");
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      await expect(client.prompt("native", "must not start after exit")).rejects.toThrow("exited");
      await vi.waitFor(() => expect(fault).toHaveBeenCalledOnce(), { timeout: 1000 });
      await prompt;
      expect(rejected).toHaveBeenCalledOnce();
      child.stdout.write(JSON.stringify(notification) + "\n");
      await new Promise((resolve) => setImmediate(resolve));
      expect(update).toHaveBeenCalledOnce();
      expect(child.stdout.destroyed).toBe(false);
    } finally {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 1, null);
      await client.close();
    }
  });
});
