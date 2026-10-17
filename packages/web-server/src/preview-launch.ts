/** Environment-isolated, authenticated preview of the packed Web application. */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultWebDataDirectory } from "./data-paths.ts";

/** Optional preview paths, port and comma-separated Harness ids. */
export interface PreviewOptions {
  "codex-command"?: string;
  "codex-home"?: string;
  host?: string;
  port?: string;
  data?: string;
  workspace?: string;
  harness?: string;
  "session-source"?: string;
  "ch-cdp"?: string;
  "ch-control-directory"?: string;
  "ch-launcher"?: string;
  "ch-host-runtime"?: string;
  "ch-data"?: string;
  "ch-codex-home"?: string;
  "ch-plugins"?: string;
}

/**
 * Build the child process arguments and environment without Desktop routing state.
 * @param distribution Directory containing server.mjs and bundled adapters.
 * @param options Preview storage, workspace and port overrides.
 * @param environment Parent environment; credentials and PATH are preserved.
 * @returns Explicit server arguments and a new environment with Host variables and Node injection removed.
 */
export function previewLaunch(
  distribution: string,
  options: PreviewOptions,
  environment: NodeJS.ProcessEnv,
): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const harnesses = [...new Set((options.harness ?? "all").split(",").map((id) => id.trim()))];
  for (const id of harnesses) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(`Harness ${id || "(empty)"} is not allowed in the isolated preview`);
    }
  }
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !name.startsWith("CODEXHOST_") &&
        !["CODEX_CLI_PATH", "NODE_OPTIONS", "NODE_PATH"].includes(name)
      );
    }),
  );
  return {
    env,
    args: [
      resolve(distribution, "server.mjs"),
      "--session-source",
      options["session-source"] ?? "codexhost",
      ...(["codex-command", "codex-home"] as const).flatMap((key) =>
        options[key] ? [`--${key}`, options[key] as string] : [],
      ),
      ...(options["ch-cdp"] ? ["--ch-cdp", options["ch-cdp"]] : []),
      ...(options["ch-control-directory"]
        ? ["--ch-control-directory", options["ch-control-directory"]]
        : []),
      ...(
        ["ch-launcher", "ch-host-runtime", "ch-data", "ch-codex-home", "ch-plugins"] as const
      ).flatMap((key) => (options[key] ? [`--${key}`, options[key] as string] : [])),
      "--host",
      options.host ?? "0.0.0.0",
      "--port",
      options.port ?? "4400",
      "--adapters",
      resolve(distribution, "adapters"),
      "--harness",
      harnesses.join(","),
      "--data",
      resolve(
        options.data ??
          defaultWebDataDirectory(
            options["ch-data"] ??
              (options["ch-control-directory"]
                ? dirname(resolve(options["ch-control-directory"]))
                : undefined),
          ),
      ),
      "--workspace",
      resolve(options.workspace ?? join(homedir(), "codexhost-web-preview-workspace")),
    ],
  };
}
