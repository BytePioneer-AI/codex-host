import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// SDK 1.0.25 forwards native stderr. Only allowlisted results cross this probe's IPC boundary.
if (!process.argv.includes("--worker")) {
  const child = fork(fileURLToPath(import.meta.url), [...process.argv.slice(2), "--worker"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: process.platform !== "win32",
  });
  let result;
  child.on("message", (value) => {
    result = value;
  });
  const timer = setTimeout(() => {
    if (process.platform === "win32") child.kill("SIGKILL");
    else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }, 45_000);
  child.once("exit", (code) => {
    clearTimeout(timer);
    console.log(JSON.stringify(result ?? { status: "probeTimedOutOrExited" }, null, 2));
    process.exitCode = code === 0 && result ? 0 : 1;
  });
} else {
  const { createCopilotClient } = await import("../dist/client.js");
  const { resolveCopilotExecutable } = await import("../dist/command.js");
  const { readModels } = await import("../dist/configuration.js");
  const environment = { ...process.env };
  const withoutOverrides = process.argv.includes("--without-auth-overrides");
  if (withoutOverrides) {
    for (const name of [
      "COPILOT_SDK_AUTH_TOKEN",
      "GITHUB_COPILOT_API_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ])
      delete environment[name];
  }
  let client;
  let result;
  try {
    const executable = resolveCopilotExecutable({ environment });
    client = createCopilotClient({ cwd: process.cwd(), environment });
    await client.start();
    const status = await client.getStatus();
    const before = (await client.listSessions()).map(({ sessionId }) => sessionId).sort();
    const auth = await client.getAuthStatus();
    const models = await readModels(client, undefined, auth);
    const after = (await client.listSessions()).map(({ sessionId }) => sessionId).sort();
    result = {
      status: "queried",
      sdkVersion: "1.0.25",
      cliVersion: status.version,
      protocolVersion: status.protocolVersion,
      platform: process.platform,
      arch: process.arch,
      executable,
      withoutAuthOverrides: withoutOverrides,
      isAuthenticated: auth.isAuthenticated,
      authType: auth.authType ?? null,
      modelCount: models.length,
      modelIds: models.map(({ id }) => id),
      sessionsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    };
  } catch (error) {
    result = { status: error?.code === "notInstalled" ? "notInstalled" : "nativeFailure" };
    process.exitCode = 1;
  } finally {
    if (client) {
      const errors = await client.stop().catch(() => [new Error("stop failed")]);
      result.stopErrorCount = errors.length;
      if (errors.length) {
        await client.forceStop();
        process.exitCode = 1;
      }
    }
  }
  process.send(result, () => process.disconnect());
}
