import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  symlink,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCopilotInstallation } from "../src/installation.js";

describe("Copilot installation ownership", () => {
  it.runIf(process.platform !== "win32")(
    "updates only the discovered npm prefix and coalesces concurrent requests",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "copilot-npm-fixture-"));
      const bin = path.join(root, "bin");
      const pkg = path.join(root, "lib/node_modules/@github/copilot");
      const log = path.join(root, "npm-log.jsonl");
      await mkdir(bin, { recursive: true });
      await mkdir(pkg, { recursive: true });
      await writeFile(
        path.join(pkg, "package.json"),
        JSON.stringify({
          name: "@github/copilot",
          version: "1.0.0",
          type: "module",
          bin: { copilot: "npm-loader.js" },
        }),
      );
      await writeFile(
        path.join(pkg, "npm-loader.js"),
        '#!/usr/bin/env node\nimport{readFileSync}from"node:fs";console.log(JSON.parse(readFileSync(new URL("./package.json",import.meta.url),"utf8")).version);\n',
      );
      await chmod(path.join(pkg, "npm-loader.js"), 0o755);
      await symlink(path.join(pkg, "npm-loader.js"), path.join(bin, "copilot"));
      await writeFile(
        path.join(bin, "npm"),
        '#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path");const args=process.argv.slice(2);fs.appendFileSync(process.env.CODEXHOST_COPILOT_TEST_NPM_LOG,JSON.stringify(args)+"\\n");const prefix=args[args.indexOf("--prefix")+1];const file=path.join(prefix,"lib/node_modules/@github/copilot/package.json");const data=JSON.parse(fs.readFileSync(file,"utf8"));data.version="1.0.2";fs.writeFileSync(file,JSON.stringify(data));\n',
      );
      await chmod(path.join(bin, "npm"), 0o755);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify({ version: "1.0.2" }), { status: 200 }),
        );
      try {
        const installation = createCopilotInstallation({
          ...process.env,
          PATH: bin + path.delimiter + path.dirname(process.execPath),
          CODEXHOST_COPILOT_COMMAND: path.join(bin, "copilot"),
          CODEXHOST_COPILOT_TEST_NPM_LOG: log,
        });
        expect(await installation("check")).toMatchObject({
          currentVersion: "1.0.0",
          latestVersion: "1.0.2",
          canUpdate: true,
          updateAvailable: true,
        });
        const results = await Promise.all([installation("update"), installation("update")]);
        expect(results.every((value) => value.currentVersion === "1.0.2")).toBe(true);
        const calls = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls).toEqual([
          ["install", "--global", "--prefix", await realpath(root), "@github/copilot@1.0.2"],
        ]);
      } finally {
        fetch.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
