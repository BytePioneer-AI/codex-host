import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyGrokComputerUsePreference,
  getGrokComputerUseSettings,
  setGrokComputerUseEnabled,
} from "../src/grok-computer-use.js";

let root: string;

async function chatgptTree(): Promise<string> {
  const app = path.join(root, "ChatGPT.app");
  const cua = path.join(app, "Contents", "Resources", "cua_node");
  await mkdir(path.join(cua, "bin"), { recursive: true });
  await mkdir(path.join(cua, "lib", "node_modules", "@oai", "cua-repl", "bin"), {
    recursive: true,
  });
  await mkdir(path.join(app, "Contents", "Resources", "codex-cli", "bin"), { recursive: true });
  await writeFile(path.join(cua, "bin", "node"), "");
  await writeFile(path.join(cua, "bin", "node_repl"), "");
  await writeFile(
    path.join(cua, "lib", "node_modules", "@oai", "cua-repl", "bin", "cua-repl.mjs"),
    "",
  );
  await writeFile(path.join(app, "Contents", "Resources", "codex-cli", "bin", "codex"), "");
  await mkdir(path.join(root, "home", ".codex", "computer-use", "Codex Computer Use.app"), {
    recursive: true,
  });
  return app;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "grok-computer-use-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Grok Computer Use settings", () => {
  it("defaults off when the user never opted in", async () => {
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: path.join(root, "grok"),
      HOME: path.join(root, "home"),
    };
    await expect(getGrokComputerUseSettings(environment, "linux")).resolves.toMatchObject({
      enabled: false,
      available: false,
    });
  });

  it("infers enabled from an existing cua_repl stanza and can disable it", async () => {
    const grokHome = path.join(root, "grok");
    await mkdir(grokHome, { recursive: true });
    await writeFile(
      path.join(grokHome, "config.toml"),
      `[ui]\nfoo = 1\n\n[mcp_servers.cua_repl]\ncommand = "/bin/echo"\nenabled = true\n\n[privacy]\nx = 1\n`,
    );
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: grokHome,
      HOME: path.join(root, "home"),
    };
    await expect(getGrokComputerUseSettings(environment, "linux")).resolves.toMatchObject({
      enabled: true,
    });
    await setGrokComputerUseEnabled(false, environment, "linux");
    expect(await readFile(path.join(grokHome, "config.toml"), "utf8")).toMatch(/enabled = false/);
    expect(await readFile(path.join(grokHome, "config.toml"), "utf8")).toContain("[ui]");
    expect(await readFile(path.join(grokHome, "config.toml"), "utf8")).toContain("[privacy]");
  });

  it("writes a computer-only cua_repl stanza when ChatGPT Computer Use files exist", async () => {
    const app = await chatgptTree();
    const grokHome = path.join(root, "grok");
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: grokHome,
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await expect(setGrokComputerUseEnabled(true, environment, "darwin")).resolves.toEqual({
      enabled: true,
      available: true,
    });
    const toml = await readFile(path.join(grokHome, "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.cua_repl]");
    expect(toml).toContain('CUA_REPL_ENABLED_SURFACES = "computer"');
    expect(toml).toContain("cua-repl.mjs");
    await applyGrokComputerUsePreference(environment, "darwin");
    expect(await readFile(path.join(grokHome, "config.toml"), "utf8")).toContain("enabled = true");
  });

  it("refuses to enable when Computer Use files are missing", async () => {
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: path.join(root, "grok"),
      HOME: path.join(root, "home"),
    };
    await expect(setGrokComputerUseEnabled(true, environment, "darwin")).rejects.toThrow(
      /ChatGPT Desktop Computer Use files were not found/,
    );
  });
});
