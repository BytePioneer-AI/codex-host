/** Launch the packed preview without inheriting CodexHost routing. */
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

import { previewLaunch } from "../src/preview-launch.ts";
import { assertDefaultWebDataReady } from "../src/data-paths.ts";

const { values } = parseArgs({
  options: {
    "codex-command": { type: "string" },
    "codex-home": { type: "string" },
    "session-source": { type: "string" },
    "ch-cdp": { type: "string" },
    "ch-control-directory": { type: "string" },
    "ch-launcher": { type: "string" },
    "ch-host-runtime": { type: "string" },
    "ch-data": { type: "string" },
    "ch-codex-home": { type: "string" },
    "ch-plugins": { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    data: { type: "string" },
    workspace: { type: "string" },
    harness: { type: "string" },
  },
});
const distribution = import.meta.filename.endsWith(".mjs")
  ? import.meta.dirname
  : resolve(import.meta.dirname, "../dist/codexhost-web");
const adapters = resolve(distribution, "adapters");
const available = readdirSync(adapters, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(resolve(adapters, entry.name, "manifest.json")),
  )
  .map((entry) => ({
    directory: entry.name,
    manifest: JSON.parse(readFileSync(resolve(adapters, entry.name, "manifest.json"), "utf8")) as {
      id: string;
      kind?: string;
    },
  }));
const requested =
  values.harness ?? (values["session-source"] === "standalone" ? "claude-code" : "all");
const harness =
  requested === "all"
    ? available
        .filter(
          ({ manifest }) =>
            manifest.kind !== "usage" &&
            !(values["session-source"] === "standalone" && manifest.id === "codex"),
        )
        .map(({ manifest }) => manifest.id)
        .sort()
        .join(",")
    : requested;
const launch = previewLaunch(
  distribution,
  { ...values, ...(harness === undefined ? {} : { harness }) },
  process.env,
);
if (values.data === undefined && !values["ch-data"] && !values["ch-control-directory"])
  assertDefaultWebDataReady(launch.args[launch.args.indexOf("--data") + 1] as string);
const selected = launch.args[launch.args.indexOf("--harness") + 1] as string;
for (const id of selected.split(",")) {
  if (
    !available.some(
      ({ directory, manifest }) =>
        directory === id && manifest.id === id && manifest.kind !== "usage",
    )
  ) {
    throw new Error(`Preview requires a bundled session Adapter for ${id}`);
  }
}
// Supply the existing Codex connection's CLI path; no Adapter or owner contract changes.
if (selected.split(",").includes("codex") && !values["codex-command"]) {
  const launcher =
    values["ch-launcher"] ??
    resolve(distribution, "native", process.platform === "win32" ? "codexhost.exe" : "codexhost");
  for (const [command, args, pattern] of [
    [launcher, ["inspect"], /^executable_codex_cli=(.+)$/mu],
    [process.platform === "win32" ? "where.exe" : "which", ["codex"], /^(.+)$/mu],
  ] as const) {
    try {
      const { stdout } = await promisify(execFile)(command, [...args], {
        env: launch.env,
        timeout: 5000,
        windowsHide: true,
      });
      const cli = pattern.exec(stdout)?.[1]?.trim();
      if (cli) {
        launch.args.push("--codex-command", cli);
        break;
      }
    } catch {
      // Not installed is normal; the server reports a failed Codex connection and continues.
    }
  }
}
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
