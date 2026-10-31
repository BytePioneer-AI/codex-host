import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { codexChildEnvironment, codexHome, resolveCodexExecutable } from "../src/command.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "codex-cli-discovery-")));
  roots.push(directory);
  return directory;
}

function executable(path: string): string {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o700);
  return path;
}

describe("Codex CLI executable discovery", () => {
  it("reports notInstalled when nothing resolves", () => {
    const directory = root();
    expect(
      resolveCodexExecutable({
        command: join(directory, "missing-codex"),
        environment: { HOME: directory, PATH: join(directory, "empty") },
        platform: "linux",
      }),
    ).toEqual({ status: "notInstalled" });
  });

  it("resolves a native codex from PATH or the persisted launch setting", () => {
    const directory = root();
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const command = executable(join(bin, "codex"));
    expect(
      resolveCodexExecutable({
        environment: { HOME: directory, PATH: bin },
        platform: "linux",
      }),
    ).toEqual({ status: "ready", command });
    expect(
      resolveCodexExecutable({
        command,
        environment: { HOME: directory, PATH: join(directory, "empty") },
        platform: "linux",
      }),
    ).toEqual({ status: "ready", command });
  });

  it("refuses a codexhost proxy, a shim alias and the Desktop routing entrypoint", () => {
    const directory = root();
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const proxy = executable(join(bin, "codexhost-proxy"));
    const alias = join(bin, "codex");
    symlinkSync(proxy, alias);
    expect(
      resolveCodexExecutable({
        environment: { HOME: directory, PATH: bin },
        platform: "linux",
      }),
    ).toEqual({ status: "unavailable" });
    const native = executable(join(bin, "native-codex"));
    expect(
      resolveCodexExecutable({
        command: native,
        environment: { HOME: directory, PATH: bin, CODEX_CLI_PATH: native },
        platform: "linux",
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("uses CODEX_HOME or the user's own native home", () => {
    expect(codexHome({ HOME: "/home/user" })).toBe("/home/user/.codex");
    expect(codexHome({ HOME: "/home/user", CODEX_HOME: "/custom/codex" })).toBe("/custom/codex");
  });

  it("preserves the Host CLI connection while removing Desktop routing and Node injection", () => {
    const delegation = {
      CODEXHOST_CLI_PATH: "/host/codexhost",
      CODEXHOST_CLI_NODE_PATH: "/host/node",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
      CODEXHOST_RUNTIME_TOKEN: "synthetic-runtime-token",
      CODEXHOST_THREAD_ID: "host-thread",
    };
    const child = codexChildEnvironment(
      {
        HOME: "/home/user",
        PATH: "/usr/bin",
        CODEX_HOME: "/custom/codex",
        ...delegation,
        CODEXHOST_HOST_RUNTIME_PATH: "/desktop/runtime",
        CODEXHOST_UNKNOWN_SETTING: "not-a-session-variable",
        CODEX_CLI_PATH: "/desktop/shim",
        CODEX_THREAD_ID: "gui-thread",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
        NODE_OPTIONS: "--import=/desktop/hook.mjs",
        NODE_PATH: "/desktop/node",
      },
      "/custom/codex",
    );
    expect(child).toEqual({
      HOME: "/home/user",
      PATH: "/usr/bin",
      CODEX_HOME: "/custom/codex",
      ...delegation,
    });
  });
});
