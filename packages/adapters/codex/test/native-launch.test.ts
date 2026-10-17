import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it } from "vitest";

import { nativeCodexLaunch } from "../src/native-launch.ts";
import { createHarnessAdapter } from "../src/plugin.ts";

let root: string;
let command: string;
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "web-codex-native-")));
  command = join(root, "native-codex");
  writeFileSync(command, "unused native executable fixture");
  environment = {
    HOME: root,
    CODEXHOST_CODEX_COMMAND: command,
    CODEXHOST_CODEX_HOME: join(root, "web-home"),
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Web Codex native launch isolation", () => {
  it("requires explicit absolute CLI and home paths without falling back to PATH or GUI settings", () => {
    for (const value of [undefined, "codex", "./codex"]) {
      assert.throws(
        () => nativeCodexLaunch({ ...environment, CODEXHOST_CODEX_COMMAND: value }),
        /absolute native CLI/u,
      );
    }
    for (const value of [undefined, "./web-home"]) {
      assert.throws(
        () => nativeCodexLaunch({ ...environment, CODEXHOST_CODEX_HOME: value }),
        /absolute isolated home/u,
      );
    }
    assert.equal(existsSync(join(root, "web-home")), false);
  });

  it("rejects known proxy binaries and aliases before spawning any process", () => {
    const shim = join(root, "codexhost-shim");
    writeFileSync(shim, "unused shim fixture");
    const paths = [shim];
    if (process.platform !== "win32") {
      const alias = join(root, "codex");
      symlinkSync(shim, alias);
      paths.push(alias);
    }
    for (const path of paths) {
      assert.throws(
        () => nativeCodexLaunch({ ...environment, CODEXHOST_CODEX_COMMAND: path }),
        /not a Desktop proxy/u,
      );
    }
    assert.throws(
      () => nativeCodexLaunch({ ...environment, CODEX_CLI_PATH: command }),
      /not a Desktop proxy/u,
    );
  });

  it("rejects the default, inherited and explicitly identified GUI homes and overlapping ancestors", () => {
    for (const home of [join(root, ".codex"), join(root, ".codex", "web"), root]) {
      assert.throws(
        () => nativeCodexLaunch({ ...environment, CODEXHOST_CODEX_HOME: home }),
        /separate from the GUI/u,
      );
    }
    for (const key of ["CODEX_HOME", "CODEXHOST_GUI_CODEX_HOME"]) {
      assert.throws(
        () => nativeCodexLaunch({ ...environment, [key]: environment.CODEXHOST_CODEX_HOME }),
        /separate from the GUI/u,
      );
    }
    assert.equal(existsSync(join(root, "web-home")), false);
  });

  it("resolves symlinked homes and existing ancestors before validating isolation", () => {
    mkdirSync(join(root, ".codex"));
    symlinkSync(
      join(root, ".codex"),
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const home of [join(root, "alias"), join(root, "alias", "not-created-yet")]) {
      assert.throws(
        () => nativeCodexLaunch({ ...environment, CODEXHOST_CODEX_HOME: home }),
        /separate from the GUI/u,
      );
    }
    assert.equal(existsSync(join(root, ".codex", "not-created-yet")), false);
  });

  it("uses an isolated home and removes Desktop routing without copying authentication", () => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "auth.json"), "GUI-only fixture");
    const parent = {
      ...environment,
      CODEX_HOME: join(root, ".codex"),
      CODEXHOST_HOST_RUNTIME_PATH: "/desktop/runtime",
      CODEXHOST_FUTURE_ROUTING_SETTING: "private",
      CODEX_CLI_PATH: "/desktop/shim",
      CODEX_THREAD_ID: "gui-thread",
      NODE_OPTIONS: "--import=/desktop/hook.mjs",
      NODE_PATH: "/desktop/node",
      OPENAI_API_KEY: "explicit-api-key-fixture",
      PATH: "/usr/bin",
    };
    const original = { ...parent };
    const launch = nativeCodexLaunch(parent);
    assert.equal(launch.command, command);
    assert.deepEqual(launch.environment, {
      HOME: root,
      CODEX_HOME: join(root, "web-home"),
      OPENAI_API_KEY: "explicit-api-key-fixture",
      PATH: "/usr/bin",
    });
    assert.deepEqual(parent, original);
    assert.equal(existsSync(join(root, "web-home")), true);
    assert.equal(existsSync(join(root, "web-home", "auth.json")), false);
  });

  it("rejects missing or non-Codex resume references instead of silently creating a session", async () => {
    const adapter = createHarnessAdapter({ environment });
    try {
      for (const nativeRef of [
        undefined,
        {},
        { nativeSessionId: "" },
        { nativeSessionId: 1 },
        { nativeSessionId: "thread", harnessId: "pi" },
      ]) {
        const result = await adapter.open({ kind: "resume", cwd: root, nativeRef });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "invalidRequest");
      }
    } finally {
      await adapter.close();
    }
  });

  it("refuses unbound and different-home references for both resume and read without spawning", async () => {
    // This fixture is not executable: a native spawn would fail with nativeFailure.
    const adapter = createHarnessAdapter({ environment });
    try {
      for (const locator of [
        undefined,
        {},
        { codexHome: join(root, "other-home") },
        { codexHome: 42 },
      ]) {
        const nativeRef = { harnessId: "codex", nativeSessionId: "thread", locator };
        for (const result of [
          await adapter.open({ kind: "resume", cwd: root, nativeRef }),
          await adapter.readHistory(nativeRef),
        ]) {
          assert.equal(result.ok, false);
          if (!result.ok) {
            assert.equal(result.error.code, "sessionScopeMismatch");
            assert.equal(result.error.retryable, false);
          }
        }
      }
    } finally {
      await adapter.close();
    }
  });
});
