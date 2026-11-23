import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { probeDeepSeekExecutableGeneration } from "../src/generation-selector.js";

it.skipIf(process.platform === "win32")(
  "finds and runs an nvm installation outside PATH",
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dsh-discovery-"));
    try {
      const bin = path.join(home, ".nvm", "versions", "node", "v22.0.0", "bin");
      await mkdir(bin, { recursive: true });
      await symlink(process.execPath, path.join(bin, "node"));
      await writeFile(path.join(bin, "dsh"), '#!/usr/bin/env node\nconsole.log("0.2.2-rc.5");\n', {
        mode: 0o755,
      });
      const result = await probeDeepSeekExecutableGeneration({
        environment: { HOME: home, PATH: "" },
      });
      expect(result.command.command).toBe(path.join(bin, "dsh"));
      expect(result.version).toBe("0.2.2-rc.5");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
