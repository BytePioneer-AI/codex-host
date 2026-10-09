/** Isolated, localhost-only Claude Code preview of the packed Web application. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Optional preview paths and port; Harness selection is deliberately fixed. */
export interface PreviewOptions {
  port?: string;
  data?: string;
  workspace?: string;
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
      "--host",
      "127.0.0.1",
      "--port",
      options.port ?? "3180",
      "--adapters",
      resolve(distribution, "adapters"),
      "--harness",
      "claude-code",
      "--data",
      resolve(options.data ?? join(homedir(), ".codexhost-web-preview")),
      "--workspace",
      resolve(options.workspace ?? join(homedir(), "codexhost-web-preview-workspace")),
    ],
  };
}
