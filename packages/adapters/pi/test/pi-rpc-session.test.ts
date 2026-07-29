import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PiRpcSession } from "../src/pi-rpc-session.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

function session(scenario: "final-only" | "empty"): PiRpcSession {
  return new PiRpcSession({
    cwd: process.cwd(),
    command: process.execPath,
    commandArguments: [fixturePath],
    environment: { ...process.env, CODEXHOST_FAKE_PI_RESPONSE: scenario },
    commandTimeoutMs: 2_000,
    turnTimeoutMs: 2_000,
    closeTimeoutMs: 500,
  });
}

describe("Pi RPC text aggregation", () => {
  it("recovers final assistant text when no streaming delta was emitted", async () => {
    const rpc = session("final-only");
    const deltas: string[] = [];
    await rpc.start();

    await expect(rpc.runTextTurn("synthetic", (delta) => deltas.push(delta))).resolves.toEqual({
      text: "synthetic final text",
    });
    expect(deltas).toEqual(["synthetic final text"]);
    await rpc.close();
  });

  it("rejects a settled Turn that has no displayable text", async () => {
    const rpc = session("empty");
    await rpc.start();

    await expect(rpc.runTextTurn("synthetic", () => undefined)).rejects.toThrow(
      "settled without text output",
    );
    await rpc.close();
  });
});
