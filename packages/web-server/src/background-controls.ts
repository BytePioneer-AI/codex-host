/** Local connection-page controls for the supervised Web process. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { WebBackgroundState } from "@codexhost/shared-contracts";
import type { AccessTokenStore } from "./access-tokens.ts";
import { localAccessTokens } from "./access-token-rpc.ts";
import { saveServiceOptions, SETTINGS_CHANGED_EXIT_CODE } from "./background-service.ts";
import type { DataDir } from "./store.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

const exec = promisify(execFile);

async function autostart(launcher: string, action: "on" | "off" | "status"): Promise<string> {
  try {
    return (await exec(launcher, ["autostart", action])).stdout.trim();
  } catch (error) {
    // The Launcher contract reports on/off failures on stderr with a nonzero exit code.
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

export async function autostartState(launcher: string): Promise<WebBackgroundState["autostart"]> {
  const status = await autostart(launcher, "status");
  if (status === "on" || status === "off") return { status };
  if (status.startsWith("invalid ")) return { status: "invalid", reason: status.slice(8) };
  throw new Error(`Invalid autostart status: ${status}`);
}

export function registerBackgroundControls(
  rpc: RpcRegistry,
  tokens: AccessTokenStore | undefined,
  options: {
    background: boolean;
    port(): number;
    data: DataDir;
    launcher: string;
    shutdown(exitCode: number): Promise<void>;
  },
): void {
  const enabled = z.object({ enabled: z.boolean() }).strict();
  const requireBackground = () => {
    if (!options.background)
      throw new RpcError("web/background-required", "Web is not running in background mode", {});
  };
  rpc.register("codexhost/lanSet", (args, context) => {
    localAccessTokens(tokens, context.auth, options.port());
    requireBackground();
    const input = enabled.parse(args);
    const changed = saveServiceOptions(options.data, {
      host: input.enabled ? "0.0.0.0" : "127.0.0.1",
    });
    if (changed)
      context.afterResponse?.(() => {
        void options.shutdown(SETTINGS_CHANGED_EXIT_CODE);
      });
    return { changed };
  });
  rpc.register("codexhost/autostartSet", async (args, context) => {
    localAccessTokens(tokens, context.auth, options.port());
    requireBackground();
    const input = enabled.parse(args);
    await autostart(options.launcher, input.enabled ? "on" : "off");
    return autostartState(options.launcher);
  });
}
