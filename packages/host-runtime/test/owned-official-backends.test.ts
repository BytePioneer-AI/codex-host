import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const relays = vi.hoisted(() => [] as Array<{ stderr: PassThrough }>);

vi.mock("../src/native-process-relay.js", () => ({
  NativeProcessRelay: class {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly processId = 42;
    readonly closed = new Promise<never>(() => undefined);

    constructor() {
      relays.push(this);
    }

    async start(): Promise<void> {
      this.stderr.write("native rpc error: synthetic-access-token\n");
      this.stderr.write("listening on: ws://127.0.0.1:43210\n");
    }

    async stop(): Promise<void> {}
    closeInput(): void {}
  },
}));

import { createOwnedLoopbackBackend } from "../src/codex-runtime/owned-official-backends.js";

describe("managed official loopback diagnostics", () => {
  it("drains native stderr without forwarding credential-bearing output", async () => {
    const diagnosticOutput = new PassThrough();
    let diagnostics = "";
    diagnosticOutput.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    const backend = createOwnedLoopbackBackend({
      stockCodexPath: "/synthetic/codex",
      arguments: ["app-server", "--listen", "ws://127.0.0.1:0"],
      cwd: "/synthetic",
      environment: {},
      diagnosticOutput,
      supervision: {
        launcher: "/synthetic/launcher",
        files: { read: vi.fn(async () => null) },
        receipt: { directory: "/synthetic", name: "receipt", tag: "tag" },
      },
    });

    await backend.start();
    relays.at(-1)?.stderr.write("refresh failed: synthetic-refresh-token\n");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(diagnostics).toBe("");
    expect(diagnostics).not.toContain("synthetic-access-token");
    expect(diagnostics).not.toContain("synthetic-refresh-token");
  });
});
