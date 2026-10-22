import path from "node:path";
import { homedir } from "node:os";

/** Restart the already-built backend through the native lifecycle operation. */
export async function restartDevelopmentHost({ artifacts, environment, run }) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEXHOST_NPM_") || key === "CODEXHOST_DEV_VERSION") delete env[key];
  }
  console.log("codexhost dev: restarting shared Host; running tasks will be interrupted");
  const result = await run(
    {
      command: artifacts.launcher,
      arguments: [
        "host",
        "restart",
        "--node",
        artifacts.node,
        "--host-runtime",
        artifacts.hostRuntime,
        "--data",
        path.resolve(env.CODEXHOST_DATA_DIR || path.join(homedir(), ".codexhost")),
      ],
    },
    env,
  );
  if (result.code !== 0) throw new Error("Shared Host restart failed; interface was not started");
}
