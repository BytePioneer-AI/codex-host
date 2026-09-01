import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CURSOR_COMMAND_ENV,
  CursorExecutableError,
  classifyCursorCliText,
  cursorInvocation,
  resolveCursorExecutable,
} from "../src/index.js";

const fixture = path.resolve(import.meta.dirname, "fixtures/fake-cursor-acp.mjs");

function isolatedHome(): string {
  return path.join(
    tmpdir(),
    `codexhost-cursor-cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

describe("Cursor CLI discovery", () => {
  it("classifies Cursor and Grok identity text", () => {
    expect(classifyCursorCliText("Start the Cursor Agent\nACP (Agent Client Protocol)")).toBe(
      "cursor",
    );
    expect(classifyCursorCliText("2026.08.25-3e8eec8")).toBe("cursor");
    expect(classifyCursorCliText("Grok Build TUI\nUsage: agent [OPTIONS]")).toBe("grok");
    expect(classifyCursorCliText("grok 1.0.13 (5e9a585)")).toBe("grok");
    expect(classifyCursorCliText("some other agent")).toBe("unknown");
  });

  it("prefers PATH cursor-agent and reports its version", () => {
    const home = isolatedHome();
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, "cursor-agent");
    copyFileSync(fixture, executable);
    chmodSync(executable, 0o755);
    const resolved = resolveCursorExecutable({
      environment: { PATH: bin, HOME: home },
      homeDirectory: home,
    });
    expect(resolved.executable).toBe(executable);
    expect(resolved.source).toBe("path");
    expect(resolved.version).toBe("2026.08.25-3e8eec8");
  });

  it("rejects a missing installation", () => {
    const home = isolatedHome();
    expect(() =>
      resolveCursorExecutable({
        environment: { PATH: path.join(home, "empty"), HOME: home },
        homeDirectory: home,
      }),
    ).toThrow(CursorExecutableError);
    try {
      resolveCursorExecutable({
        environment: { PATH: path.join(home, "empty"), HOME: home },
        homeDirectory: home,
      });
    } catch (error) {
      expect(error).toMatchObject({ kind: "notInstalled" });
    }
  });

  it("rejects a Grok `agent` as the wrong identity", () => {
    const home = isolatedHome();
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    chmodSync(fixture, 0o755);
    expect(() =>
      resolveCursorExecutable({
        environment: {
          PATH: bin,
          HOME: home,
          FAKE_CURSOR_IDENTITY: "grok",
          [CURSOR_COMMAND_ENV]: fixture,
        },
        homeDirectory: home,
        command: fixture,
      }),
    ).toThrow(/Grok|not Cursor/u);
    try {
      resolveCursorExecutable({
        command: fixture,
        environment: { PATH: bin, HOME: home, FAKE_CURSOR_IDENTITY: "grok" },
        homeDirectory: home,
      });
    } catch (error) {
      expect(error).toMatchObject({ kind: "wrongIdentity" });
    }
  });

  it("does not silently replace an explicit override", () => {
    const home = isolatedHome();
    expect(() =>
      resolveCursorExecutable({
        command: path.join(home, "missing-cursor"),
        environment: { PATH: path.dirname(fixture), HOME: home },
        homeDirectory: home,
      }),
    ).toThrow(/Configured Cursor CLI is not installed|not installed/u);
  });

  it("reports a non-executable configured command", () => {
    const home = isolatedHome();
    mkdirSync(home, { recursive: true });
    const file = path.join(home, "cursor-agent");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o644);
    try {
      resolveCursorExecutable({
        command: file,
        environment: { PATH: "", HOME: home },
        homeDirectory: home,
      });
      throw new Error("expected notExecutable");
    } catch (error) {
      expect(error).toMatchObject({ kind: "notExecutable" });
    }
  });

  it("rejects PATH `agent` that is Grok when cursor-agent is absent", () => {
    const home = isolatedHome();
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, "agent");
    copyFileSync(fixture, executable);
    chmodSync(executable, 0o755);
    try {
      resolveCursorExecutable({
        environment: { PATH: bin, HOME: home, FAKE_CURSOR_IDENTITY: "grok" },
        homeDirectory: home,
      });
      throw new Error("expected wrongIdentity");
    } catch (error) {
      expect(error).toMatchObject({ kind: "wrongIdentity" });
    }
  });

  it("spawns ACP with an argument array", () => {
    expect(cursorInvocation("/opt/cursor-agent")).toEqual({
      command: "/opt/cursor-agent",
      arguments: ["acp"],
      windowsVerbatimArguments: false,
    });
  });
});
