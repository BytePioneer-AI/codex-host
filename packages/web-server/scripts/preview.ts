/** Launch the packed Claude Code preview without inheriting CodexHost routing. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { previewLaunch } from "../src/preview-launch.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    data: { type: "string" },
    workspace: { type: "string" },
  },
});
const distribution = import.meta.filename.endsWith(".mjs")
  ? import.meta.dirname
  : resolve(import.meta.dirname, "../dist/codexhost-web");
const manifest = JSON.parse(
  readFileSync(resolve(distribution, "adapters/claude-code/manifest.json"), "utf8"),
) as { id: string };
if (manifest.id !== "claude-code")
  throw new Error("Preview requires a bundled Claude Code Adapter");
const launch = previewLaunch(distribution, values, process.env);
const child = spawn(process.execPath, launch.args, {
  env: launch.env,
  cwd: distribution,
  stdio: "inherit",
});
const interrupt = (): void => {
  child.kill("SIGINT");
};
const terminate = (): void => {
  child.kill("SIGTERM");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  process.exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 143)));
  });
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
