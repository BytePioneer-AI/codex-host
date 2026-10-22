import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyGrokComputerUsePreference,
  getGrokComputerUseSettings,
  setGrokComputerUse,
  setGrokComputerUseEnabled,
} from "../src/grok-computer-use.js";

let root: string;

async function chatgptTree(options: { browser?: boolean; sky?: boolean } = {}): Promise<string> {
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
  if (options.browser) {
    const browserDesktop = path.join(cua, "lib", "node_modules", "@oai", "browser-desktop");
    await mkdir(browserDesktop, { recursive: true });
    await writeFile(path.join(browserDesktop, "package.json"), "{}");
  }
  if (options.sky !== false) {
    await mkdir(path.join(root, "home", ".codex", "computer-use", "Codex Computer Use.app"), {
      recursive: true,
    });
  }
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
    await expect(setGrokComputerUseEnabled(true, environment, "darwin")).resolves.toMatchObject({
      enabled: true,
      browser: false,
      available: true,
    });
    const toml = await readFile(path.join(grokHome, "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.cua_repl]");
    expect(toml).toContain('CUA_REPL_ENABLED_SURFACES = "computer"');
    expect(toml).not.toContain("BROWSER_USE_AVAILABLE_BACKENDS");
    expect(toml).toContain('{\\"sky\\":\\"@oai/sky/service\\"}');
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
  it("saves browser intent without enabling the IAB surface until Desktop binding is supported", async () => {
    const app = await chatgptTree({ browser: true });
    const grokHome = path.join(root, "grok");
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: grokHome,
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await setGrokComputerUse({ enabled: true }, environment, "darwin");
    await expect(
      setGrokComputerUse({ browser: true }, environment, "darwin"),
    ).resolves.toMatchObject({
      enabled: true,
      browser: true,
      browserFilesPresent: true,
      browserAvailable: false,
    });
    const toml = await readFile(path.join(grokHome, "config.toml"), "utf8");
    expect(toml).toContain('CUA_REPL_ENABLED_SURFACES = "computer"');
    expect(toml).not.toContain("BROWSER_USE_AVAILABLE_BACKENDS");
    expect(toml).not.toContain("browser-desktop");
  });

  it("does not let an inherited binding override claim IAB availability", async () => {
    const app = await chatgptTree({ browser: true });
    const grokHome = path.join(root, "grok");
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: grokHome,
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
      CODEXHOST_GROK_IAB_BINDING: "1",
    };
    await expect(
      setGrokComputerUse({ enabled: true, browser: true }, environment, "darwin"),
    ).resolves.toMatchObject({ browser: true, browserAvailable: false });
    const toml = await readFile(path.join(grokHome, "config.toml"), "utf8");
    expect(toml).toContain('CUA_REPL_ENABLED_SURFACES = "computer"');
    expect(toml).not.toContain("browser-desktop");
    expect(toml).not.toContain("BROWSER_USE_AVAILABLE_BACKENDS");
    await setGrokComputerUse({ enabled: false }, environment, "darwin");
    expect(await readFile(path.join(grokHome, "config.toml"), "utf8")).toContain("enabled = false");
  });

  it("lets browser intent be saved when Sky is absent", async () => {
    const app = await chatgptTree({ browser: true, sky: false });
    const grokHome = path.join(root, "grok");
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: grokHome,
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      available: false,
      browserFilesPresent: true,
      browserAvailable: false,
    });
    await expect(setGrokComputerUse({ enabled: true }, environment, "darwin")).rejects.toThrow(
      /Computer Use files were not found/,
    );
    await expect(
      setGrokComputerUse({ browser: true }, environment, "darwin"),
    ).resolves.toMatchObject({ browser: true, available: false, browserFilesPresent: true });
  });

  it("keeps both fields when concurrent partial writes run", async () => {
    const app = await chatgptTree({ browser: true });
    const grokHome = path.join(root, "grok");
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: grokHome,
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await Promise.all([
      setGrokComputerUse({ enabled: true }, environment, "darwin"),
      setGrokComputerUse({ browser: true }, environment, "darwin"),
    ]);
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      enabled: true,
      browser: true,
    });
  });

  it("merges partial saves from separate Host and console processes", async () => {
    const app = await chatgptTree({ browser: true });
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: path.join(root, "grok"),
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    const moduleUrl = new URL("../dist/grok-computer-use.js", import.meta.url).href;
    const run = promisify(execFile);
    await Promise.all(
      [{ enabled: true }, { browser: true }].map((update) =>
        run(process.execPath, [
          "--input-type=module",
          "-e",
          `const {setGrokComputerUse}=await import(process.argv[1]); await setGrokComputerUse(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]), "darwin");`,
          moduleUrl,
          JSON.stringify(update),
          JSON.stringify(environment),
        ]),
      ),
    );
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      enabled: true,
      browser: true,
      browserAvailable: false,
    });
    const toml = await readFile(path.join(environment.GROK_HOME, "config.toml"), "utf8");
    expect(toml).toContain('CUA_REPL_ENABLED_SURFACES = "computer"');
    await Promise.all([
      setGrokComputerUse({ enabled: false }, environment, "darwin"),
      applyGrokComputerUsePreference(environment, "darwin"),
    ]);
    expect(await readFile(path.join(environment.GROK_HOME, "config.toml"), "utf8")).toContain(
      "enabled = false",
    );
  });

  it("reports a failed config apply without changing saved intent", async () => {
    const app = await chatgptTree({ browser: true });
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: path.join(root, "grok"),
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await setGrokComputerUse({ enabled: false, browser: false }, environment, "darwin");
    await mkdir(path.join(environment.GROK_HOME, "config.toml"));
    await expect(setGrokComputerUse({ enabled: true }, environment, "darwin")).rejects.toThrow();
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      enabled: false,
      browser: false,
      applyFailed: true,
    });
    await rm(path.join(environment.GROK_HOME, "config.toml"), { recursive: true });
    await applyGrokComputerUsePreference(environment, "darwin");
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      enabled: false,
    });
    expect((await getGrokComputerUseSettings(environment, "darwin")).applyFailed).toBeUndefined();
  });

  it("fails closed when in-app browser files are missing", async () => {
    const app = await chatgptTree();
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: path.join(root, "grok"),
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await expect(setGrokComputerUse({ browser: true }, environment, "darwin")).rejects.toThrow(
      /in-app browser files were not found/,
    );
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      browser: false,
      browserAvailable: false,
    });
  });

  it("infers browser-only intent without enabling Computer Use", async () => {
    const app = await chatgptTree({ browser: true, sky: false });
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: path.join(root, "grok"),
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await mkdir(environment.GROK_HOME);
    await writeFile(
      path.join(environment.GROK_HOME, "config.toml"),
      '[mcp_servers.cua_repl]\nenabled = true\n\n[mcp_servers.cua_repl.env]\nCUA_REPL_ENABLED_SURFACES = "browser"\n',
    );
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      enabled: false,
      browser: true,
      available: false,
      browserAvailable: false,
    });
    await setGrokComputerUse({ browser: false }, environment, "darwin");
    expect(await readFile(path.join(environment.GROK_HOME, "config.toml"), "utf8")).toContain(
      "enabled = false",
    );
  });

  it("retains saved intent but disables a surface when its files disappear", async () => {
    const app = await chatgptTree({ browser: true });
    const environment = {
      CODEXHOST_DATA_DIR: path.join(root, "data"),
      GROK_HOME: path.join(root, "grok"),
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await setGrokComputerUse({ enabled: true, browser: true }, environment, "darwin");
    await rm(path.join(app, "Contents", "Resources", "codex-cli"), { recursive: true });
    await rm(
      path.join(
        app,
        "Contents",
        "Resources",
        "cua_node",
        "lib",
        "node_modules",
        "@oai",
        "browser-desktop",
      ),
      { recursive: true },
    );
    await applyGrokComputerUsePreference(environment, "darwin");
    await expect(getGrokComputerUseSettings(environment, "darwin")).resolves.toMatchObject({
      enabled: true,
      browser: true,
      available: false,
      browserFilesPresent: false,
      browserAvailable: false,
    });
    expect(await readFile(path.join(environment.GROK_HOME, "config.toml"), "utf8")).toContain(
      "enabled = false",
    );
  });

  it("keeps a Computer-only preference file working unchanged", async () => {
    const app = await chatgptTree({ browser: true });
    const dataDir = path.join(root, "data");
    const grokHome = path.join(root, "grok");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "grok-computer-use.json"), '{"enabled":true}\n');
    const environment = {
      CODEXHOST_DATA_DIR: dataDir,
      GROK_HOME: grokHome,
      HOME: path.join(root, "home"),
      CODEXHOST_CHATGPT_APP: app,
    };
    await applyGrokComputerUsePreference(environment, "darwin");
    const toml = await readFile(path.join(grokHome, "config.toml"), "utf8");
    expect(toml).toContain('CUA_REPL_ENABLED_SURFACES = "computer"');
    expect(toml).not.toContain("browser-desktop");
  });
});
