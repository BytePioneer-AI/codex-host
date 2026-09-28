import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { commandInvocation } from "@codexhost/harness-discovery";
import { withTimeout } from "./acp-transport.js";
import { isKimiModeId, type KimiModeId } from "./models.js";

export class KimiRollbackError extends Error {
  constructor(
    readonly code: "unsupported" | "sessionBusy" | "nativeFailure",
    message: string,
  ) {
    super(message);
  }
}

export interface KimiNativeRollbackOptions {
  command: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  sourceSessionId: string;
  timeoutMs: number;
}

// Start a loopback-only native server for this operation, then release it before
// ACP loads the derived session. Never edit Kimi's wire/state files ourselves.
export async function rollbackKimiNativeSession(options: KimiNativeRollbackOptions): Promise<{
  sessionId: string;
  model: string;
  thinking: string;
  mode: KimiModeId;
}> {
  const invocation = commandInvocation(
    options.command,
    ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"],
    options.environment,
  );
  const child = spawn(invocation.command, invocation.arguments, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let endpoint: { origin: string; token: string } | undefined;
  let forkId: string | undefined;
  const request = async (route: string, body?: object): Promise<Record<string, unknown>> => {
    if (!endpoint) throw new Error("Kimi rollback server is not ready");
    const response = await fetch(`${endpoint.origin}/api/v1/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const result = (await response.json()) as {
      code?: number;
      message?: string;
      data?: Record<string, unknown>;
    };
    if (!response.ok || result.code !== 0) {
      const code =
        result.code === 40901
          ? "sessionBusy"
          : result.code === 40911
            ? "unsupported"
            : "nativeFailure";
      const message =
        result.code === 40911
          ? "Kimi cannot revise this message: a compaction boundary or missing checkpoint prevents native undo. The original session is unchanged."
          : `Kimi native rollback failed (${result.code ?? response.status}): ${result.message ?? "request rejected"}`;
      throw new KimiRollbackError(code, message);
    }
    return result.data ?? {};
  };
  try {
    endpoint = await withTimeout(
      new Promise<{ origin: string; token: string }>((resolve, reject) => {
        let output = "";
        const onData = (chunk: Buffer) => {
          output = stripVTControlCharacters(output + chunk.toString()).slice(-16_384);
          const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/?#token=([^\s]+)/);
          if (match?.[1] && match[2])
            resolve({ origin: `http://127.0.0.1:${match[1]}`, token: match[2] });
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.once("error", reject);
        child.once("close", (code) => reject(new Error(`Kimi rollback server exited (${code})`)));
      }),
      options.timeoutMs,
      "Kimi rollback server startup",
    );
    const fork = await request(`sessions/${encodeURIComponent(options.sourceSessionId)}:fork`, {});
    if (typeof fork.id !== "string" || !fork.id || fork.id === options.sourceSessionId)
      throw new Error("Kimi did not return an independent rollback session");
    forkId = fork.id;
    const status = await request(`sessions/${encodeURIComponent(forkId)}/status`);
    const mode =
      status.plan_mode === true
        ? "plan"
        : status.permission === "manual"
          ? "default"
          : status.permission;
    if (
      typeof status.model !== "string" ||
      typeof status.thinking_level !== "string" ||
      !isKimiModeId(mode)
    )
      throw new Error("Kimi did not expose the configuration needed for rollback");
    await request(`sessions/${encodeURIComponent(forkId)}:undo`, { count: 1 });
    return { sessionId: forkId, model: status.model, thinking: status.thinking_level, mode };
  } catch (error) {
    if (forkId) {
      try {
        await request(`sessions/${encodeURIComponent(forkId)}:archive`, {});
      } catch {
        throw new KimiRollbackError(
          "nativeFailure",
          `${error instanceof Error ? error.message : String(error)}; could not archive derived session ${forkId}`,
        );
      }
    }
    throw error;
  } finally {
    if (endpoint && child.exitCode === null) {
      await request("shutdown", {}).catch(() => undefined);
      await withTimeout(exited, 2_000, "Kimi rollback server shutdown").catch(() => undefined);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await withTimeout(exited, 2_000, "Kimi rollback server exit");
    }
  }
}
