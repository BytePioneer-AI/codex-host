/** Isolated, localhost-only preview of the packed Web application. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Harnesses whose native CLI routing is not yet verified alongside Desktop. */
export const PREVIEW_EXCLUDED_HARNESSES: readonly string[] = ["codex", "pi"];

/** Optional preview paths, port and comma-separated Harness ids. */
export interface PreviewOptions {
  port?: string;
  data?: string;
  workspace?: string;
  harness?: string;
  "session-source"?: string;
  "ch-cdp"?: string;
  "ch-control-directory"?: string;
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
  const harnesses = [
    ...new Set((options.harness ?? "claude-code").split(",").map((id) => id.trim())),
  ];
  for (const id of harnesses) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || PREVIEW_EXCLUDED_HARNESSES.includes(id)) {
      throw new Error(`Harness ${id || "(empty)"} is not allowed in the isolated preview`);
    }
  }
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const name = key.toUpperCase();
      return !name.startsWith("CODEXHOST_") && name !== "NODE_OPTIONS" && name !== "NODE_PATH";
    }),
  );
  return {
    env,
    args: [
      resolve(distribution, "server.mjs"),
      "--session-source",
      options["session-source"] ?? "codexhost",
      ...(options["ch-cdp"] ? ["--ch-cdp", options["ch-cdp"]] : []),
      ...(options["ch-control-directory"]
        ? ["--ch-control-directory", options["ch-control-directory"]]
        : []),
      "--host",
      "127.0.0.1",
      "--port",
      options.port ?? "3180",
      "--adapters",
      resolve(distribution, "adapters"),
      "--harness",
      harnesses.join(","),
      "--data",
      resolve(options.data ?? join(homedir(), ".codexhost-web-preview")),
      "--workspace",
      resolve(options.workspace ?? join(homedir(), "codexhost-web-preview-workspace")),
    ],
  };
}
