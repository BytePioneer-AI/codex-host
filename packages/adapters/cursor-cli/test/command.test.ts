// Discovery regressions adapted from liki-0814/codex-host commit 93f45d18 (LGPL-3.0).
import path from "node:path";
import type * as HarnessDiscovery from "@codexhost/harness-discovery";
import { resolveHarnessExecutable } from "@codexhost/harness-discovery";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorNotInstalledError, cursorInvocation } from "../src/command.js";

const files = vi.hoisted(() => new Set<string>());
vi.mock("@codexhost/harness-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof HarnessDiscovery>();
  return {
    ...actual,
    resolveHarnessExecutable: (
      spec: Parameters<typeof actual.resolveHarnessExecutable>[0],
      input: Parameters<typeof actual.resolveHarnessExecutable>[1],
    ) =>
      actual.resolveHarnessExecutable(spec, input, {
        isExecutable: (file) =>
          (input.platform ?? process.platform) === "win32"
            ? [...files].some((existing) => existing.toLowerCase() === file.toLowerCase())
            : files.has(file),
      }),
  };
});

afterEach(() => files.clear());

function expectExecutable(actual: string, expected: string) {
  expect(process.platform === "win32" ? actual.toLowerCase() : actual).toBe(
    process.platform === "win32" ? expected.toLowerCase() : expected,
  );
}

function fixture() {
  const home = path.resolve("synthetic-cursor-home");
  const binary = process.platform === "win32" ? "cursor-agent.exe" : "cursor-agent";
  const local = path.join(home, "AppData", "Local");
  const root =
    process.platform === "win32"
      ? path.join(local, "cursor-agent")
      : path.join(home, ".local", "share", "cursor-agent");
  const pinned = path.join(root, "versions", "2026.09.10-fd3934a", binary);
  const shim =
    process.platform === "win32"
      ? path.join(root, binary)
      : path.join(home, ".local", "bin", binary);
  files.add(pinned);
  files.add(shim);
  const environment = {
    HOME: home,
    LOCALAPPDATA: local,
    PATH: path.dirname(pinned),
    PATHEXT: ".EXE;.CMD",
  };
  return { pinned, shim, environment };
}

describe("Cursor executable discovery", () => {
  it("prefers the rolling shim over a stale versions directory on PATH", () => {
    const { shim, environment } = fixture();
    expect(cursorInvocation(environment, undefined, ["acp"]).command).toBe(shim);
  });

  it.each(["argument", "environment"])(
    "preserves an explicit versioned command from %s",
    (source) => {
      const { pinned, environment } = fixture();
      const invocation =
        source === "argument"
          ? cursorInvocation(environment, pinned, ["acp"])
          : cursorInvocation({ ...environment, CODEXHOST_CURSOR_COMMAND: pinned }, undefined, [
              "acp",
            ]);
      expect(invocation.command).toBe(pinned);
    },
  );

  it("falls back to the installed version when there is no rolling shim", () => {
    const { pinned, shim, environment } = fixture();
    files.delete(shim);
    expectExecutable(cursorInvocation(environment, undefined, ["acp"]).command, pinned);
  });

  it("does not replace a normal PATH executable", () => {
    const { shim, environment } = fixture();
    const custom = path.join(path.dirname(environment.HOME), "custom", path.basename(shim));
    files.add(custom);
    expectExecutable(
      cursorInvocation({ ...environment, PATH: path.dirname(custom) }, undefined, ["acp"]).command,
      custom,
    );
  });

  it("models Windows file checks as case-insensitive for uppercase PATHEXT", () => {
    const directory = "C:\\cursor-discovery";
    files.add(path.win32.join(directory, "cursor-agent.exe"));
    const resolved = resolveHarnessExecutable(
      { id: "cursor-cli", command: "cursor-agent" },
      { environment: { PATH: directory, PATHEXT: ".EXE;.CMD" }, platform: "win32" },
    );
    expect(resolved?.executable).toBe(path.win32.join(directory, "cursor-agent.EXE"));
  });

  it("keeps POSIX file checks case-sensitive", () => {
    files.add("/cursor-discovery/cursor-agent");
    expect(
      resolveHarnessExecutable(
        { id: "cursor-cli", command: "CURSOR-AGENT" },
        { environment: { PATH: "/cursor-discovery" }, platform: "linux" },
      ),
    ).toBeUndefined();
  });

  it("does not fall back when an explicit command is missing", () => {
    const { environment } = fixture();
    expect(() =>
      cursorInvocation(environment, path.join(environment.HOME, "missing"), ["acp"]),
    ).toThrow("not installed");
    expect(() =>
      cursorInvocation(environment, path.join(environment.HOME, "missing"), ["acp"]),
    ).toThrow(CursorNotInstalledError);
  });

  it.each([["--force", "acp"], ["about", "--format", "json"], ["update"]])(
    "preserves invocation arguments %j",
    (...args) => {
      const { shim, environment } = fixture();
      expect(cursorInvocation(environment, undefined, args)).toMatchObject({
        command: shim,
        arguments: args,
      });
    },
  );
});
