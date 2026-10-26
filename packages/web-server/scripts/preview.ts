/** Launch the packed preview without inheriting CodexHost routing. */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { previewLaunch } from "../src/preview-launch.ts";
import { restartDevelopmentPreview } from "../src/development-restart.ts";

const { values } = parseArgs({
  options: {
    restart: { type: "boolean" },
    "restart-host": { type: "boolean" },
    "keep-host": { type: "boolean" },
    "ch-cdp": { type: "string" },
    "ch-control-directory": { type: "string" },
    "ch-launcher": { type: "string" },
    "ch-host-runtime": { type: "string" },
    "ch-data": { type: "string" },
    "ch-codex-home": { type: "string" },
    "ch-plugins": { type: "string" },
    "dev-web-ui": { type: "string" },
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
const requested = values.harness ?? "all";
const harness =
  requested === "all"
    ? available
        .filter(({ manifest }) => manifest.kind !== "usage")
        .map(({ manifest }) => manifest.id)
        .sort()
        .join(",")
    : requested;
const launch = previewLaunch(
  distribution,
  { ...values, ...(harness === undefined ? {} : { harness }) },
  process.env,
);
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
if (values.restart) await restartDevelopmentPreview(distribution, values, launch.env);
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
