import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isolateNativeEnvironment } from "./native-config.mjs";

describe("Gate C Native Live config isolation", () => {
  it("copies only mutable Pi config inputs and never writes the source directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-gate-c-config-"));
    const source = path.join(root, "user-agent");
    const cwd = path.join(root, "gate-project");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const files = {
      "settings.json": '{"defaultModel":"source-model"}\n',
      "auth.json": '{"synthetic":"credential"}\n',
      "models.json": '{"providers":{}}\n',
    };
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(source, name), contents, "utf8");
    }
    fs.writeFileSync(path.join(source, "unrelated.json"), "{}\n", "utf8");

    try {
      const env = isolateNativeEnvironment(
        { cwd },
        { PI_CODING_AGENT_DIR: source, SYNTHETIC_PROVIDER_KEY: "inherited" },
      );
      const isolatedDir = path.join(cwd, ".pi-agent");
      expect(env).toMatchObject({
        PI_CODING_AGENT_DIR: isolatedDir,
        SYNTHETIC_PROVIDER_KEY: "inherited",
      });
      for (const [name, contents] of Object.entries(files)) {
        expect(fs.readFileSync(path.join(isolatedDir, name), "utf8")).toBe(contents);
      }
      expect(fs.existsSync(path.join(isolatedDir, "unrelated.json"))).toBe(false);

      fs.writeFileSync(path.join(isolatedDir, "settings.json"), '{"defaultModel":"changed"}\n');
      isolateNativeEnvironment({ cwd }, { PI_CODING_AGENT_DIR: source });
      expect(fs.readFileSync(path.join(source, "settings.json"), "utf8")).toBe(
        files["settings.json"],
      );
      expect(fs.readFileSync(path.join(isolatedDir, "settings.json"), "utf8")).toContain("changed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
