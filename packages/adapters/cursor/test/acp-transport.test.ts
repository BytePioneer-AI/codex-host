import { chmodSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CursorAcpTransport, CursorTransportError } from "../src/index.js";

const fixture = path.resolve(import.meta.dirname, "fixtures/fake-cursor-acp.mjs");
chmodSync(fixture, 0o755);

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "codexhost-cursor-cwd-"));
}

function transport(cwd: string, environment: NodeJS.ProcessEnv = {}): CursorAcpTransport {
  return new CursorAcpTransport({
    cwd,
    command: fixture,
    environment: { ...process.env, ...environment, PATH: path.dirname(fixture) },
    commandTimeoutMs: 5_000,
    closeTimeoutMs: 1_000,
  });
}

describe("Cursor ACP transport", () => {
  it("spawns cursor-agent acp with the requested cwd", async () => {
    const cwd = workspace();
    const probe = path.join(cwd, "probe.json");
    const acp = transport(cwd, { FAKE_CURSOR_ACP_PROBE: probe });
    try {
      const initialize = await acp.inspect();
      expect(initialize.protocolVersion).toBe(1);
      expect(initialize.agentCapabilities?.loadSession).toBe(true);
      const recorded = JSON.parse(readFileSync(probe, "utf8")) as {
        argv: string[];
        cwd: string;
      };
      expect(recorded.argv).toEqual(["acp"]);
      expect(recorded.cwd).toBe(realpathSync(cwd));
    } finally {
      await acp.close();
    }
  });

  it("creates a session, streams assistant text, and completes a prompt", async () => {
    const cwd = workspace();
    const acp = transport(cwd);
    try {
      const opened = await acp.open({ kind: "create" });
      expect(opened.sessionId).toMatch(/^cursor-session-/u);
      const chunks: string[] = [];
      const response = await acp.runTurn(
        "hello",
        (event) => {
          if (event.type === "agent.text") chunks.push(event.text);
        },
        async () => ({ outcome: { outcome: "cancelled" } }),
      );
      expect(chunks.join("")).toBe("echo:hello");
      expect(response.stopReason).toBe("end_turn");
    } finally {
      await acp.close();
    }
  });

  it("contains a malformed stdout line without crashing the Host", async () => {
    const cwd = workspace();
    const acp = transport(cwd, { FAKE_CURSOR_ACP_MODE: "malformed" });
    try {
      const initialize = await acp.inspect();
      expect(initialize.protocolVersion).toBe(1);
    } finally {
      await acp.close();
    }
  });

  it("reports an abnormal ACP exit", async () => {
    const cwd = workspace();
    const acp = transport(cwd, { FAKE_CURSOR_ACP_MODE: "exit-on-prompt" });
    await acp.open({ kind: "create" });
    await expect(
      acp.runTurn(
        "boom",
        () => undefined,
        async () => ({ outcome: { outcome: "cancelled" } }),
      ),
    ).rejects.toThrow(/exited|unavailable|Cursor/u);
    await acp.close();
  });

  it("cancels an in-flight prompt", async () => {
    const cwd = workspace();
    const acp = transport(cwd, { FAKE_CURSOR_ACP_MODE: "hang-prompt" });
    try {
      await acp.open({ kind: "create" });
      const prompt = acp.runTurn(
        "wait",
        () => undefined,
        async () => ({ outcome: { outcome: "cancelled" } }),
      );
      await acp.cancel();
      await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
    } finally {
      await acp.close();
    }
  });

  it("cleans up the ACP process on close", async () => {
    const cwd = workspace();
    const acp = transport(cwd);
    await acp.inspect();
    await acp.close();
    await acp.close();
  });

  it("keeps concurrent sessions isolated", async () => {
    const first = transport(workspace());
    const second = transport(workspace());
    try {
      const openedFirst = await first.open({ kind: "create" });
      const openedSecond = await second.open({ kind: "create" });
      expect(openedFirst.sessionId).not.toBe(openedSecond.sessionId);
      const firstChunks: string[] = [];
      const secondChunks: string[] = [];
      await Promise.all([
        first.runTurn(
          "one",
          (event) => {
            if (event.type === "agent.text") firstChunks.push(event.text);
          },
          async () => ({ outcome: { outcome: "cancelled" } }),
        ),
        second.runTurn(
          "two",
          (event) => {
            if (event.type === "agent.text") secondChunks.push(event.text);
          },
          async () => ({ outcome: { outcome: "cancelled" } }),
        ),
      ]);
      expect(firstChunks.join("")).toBe("echo:one");
      expect(secondChunks.join("")).toBe("echo:two");
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("resumes when ACP advertises loadSession", async () => {
    const cwd = workspace();
    const created = transport(cwd);
    const opened = await created.open({ kind: "create" });
    await created.runTurn(
      "remember",
      () => undefined,
      async () => ({ outcome: { outcome: "cancelled" } }),
    );
    await created.close();

    const resumed = transport(cwd);
    try {
      const loaded = await resumed.open({ kind: "resume", sessionId: opened.sessionId });
      expect(loaded.sessionId).toBe(opened.sessionId);
      expect(loaded.loadSessionSupported).toBe(true);
    } finally {
      await resumed.close();
    }
  });

  it("exposes unsupported resume when loadSession is false", async () => {
    const cwd = workspace();
    const acp = transport(cwd, { FAKE_CURSOR_ACP_LOAD_SESSION: "0" });
    try {
      const initialize = await acp.inspect();
      expect(initialize.agentCapabilities?.loadSession).toBe(false);
      await expect(acp.open({ kind: "resume", sessionId: "missing" })).rejects.toBeInstanceOf(
        CursorTransportError,
      );
    } finally {
      await acp.close();
    }
  });
});
