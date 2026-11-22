import { describe, expect, it } from "vitest";
import { resolveCopilotExecutable } from "../src/command.js";
import path from "node:path";

describe("Copilot public executable discovery", () => {
  it.each(["cmd", "bat"])(
    "resolves a Windows npm .%s launcher to its own package bin without shell execution",
    (extension) => {
      const prefix = "C:\\Users\\Test User\\App Data\\npm";
      const selected = path.win32.join(prefix, `copilot.${extension}`);
      const root = path.win32.join(prefix, "node_modules", "@github", "copilot");
      const entry = path.win32.join(root, "npm-loader.js");
      const files = new Map([
        [
          selected,
          '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*',
        ],
        [
          path.win32.join(root, "package.json"),
          JSON.stringify({ name: "@github/copilot", bin: { copilot: "npm-loader.js" } }),
        ],
        [entry, "// installed entry"],
      ]);
      expect(
        resolveCopilotExecutable(
          { platform: "win32", environment: { CODEXHOST_COPILOT_COMMAND: selected } },
          {
            isExecutable: (candidate) => files.has(candidate),
            readTextFile: (file) => {
              const value = files.get(file);
              if (value === undefined) throw new Error("missing fixture file");
              return value;
            },
          },
        ),
      ).toBe(entry);
    },
  );

  it.each(["other-package", "missing-bin", "wrong-shim", "traversal"])(
    "rejects an unmatched Windows npm installation (%s) without falling back",
    (caseName) => {
      const selected = "C:\\Selected Install\\copilot.cmd";
      expect(() =>
        resolveCopilotExecutable(
          {
            platform: "win32",
            environment: { CODEXHOST_COPILOT_COMMAND: selected, PATH: "C:\\Other Install" },
          },
          {
            isExecutable: (candidate) =>
              caseName !== "missing-bin" || !candidate.endsWith("npm-loader.js"),
            readTextFile: (file) =>
              file.endsWith("package.json")
                ? JSON.stringify({
                    name: caseName === "other-package" ? "other" : "@github/copilot",
                    bin: { copilot: caseName === "traversal" ? "../../other.js" : "npm-loader.js" },
                  })
                : caseName === "wrong-shim"
                  ? 'node "C:\\Other Install\\copilot.js" %*'
                  : '"%_prog%" "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*',
          },
        ),
      ).toThrow(/command shim/);
    },
  );
  it("finds an installed CLI outside a GUI PATH", () => {
    expect(
      resolveCopilotExecutable(
        { environment: { PATH: "/usr/bin" }, homeDirectory: "/home/test", platform: "linux" },
        {
          isExecutable: (candidate) => candidate === "/home/test/.local/bin/copilot",
          subdirectories: () => [],
        },
      ),
    ).toBe("/home/test/.local/bin/copilot");
  });
  it("does not replace an explicit missing installation with another CLI", () => {
    expect(() =>
      resolveCopilotExecutable(
        {
          environment: { PATH: "/usr/bin", CODEXHOST_COPILOT_COMMAND: "/missing/copilot" },
          platform: "linux",
        },
        { isExecutable: (candidate) => candidate === "/usr/bin/copilot" },
      ),
    ).toThrow(/not found/);
  });
  it("rejects shell shims the SDK cannot spawn", () => {
    expect(() =>
      resolveCopilotExecutable(
        {
          environment: { CODEXHOST_COPILOT_COMMAND: "C:\\custom\\copilot.cmd" },
          platform: "win32",
        },
        { isExecutable: () => true },
      ),
    ).toThrow(/command shim/);
  });
});
