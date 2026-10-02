import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  harnessAccountSnapshotSchema,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

const execute = promisify(execFile);
const ENDPOINT = "https://api2.cursor.sh/aiserver.v1.DashboardService/";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const percent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(100, value)
    : undefined;

/** Use native percentage fields. Spend divided by limit omits bonus and model buckets. */
export function projectCursorAccountUsage(
  usage: unknown,
  identity: unknown,
  plan: unknown,
): HarnessAccountSnapshot | null {
  const data = record(usage);
  const buckets = record(data.planUsage);
  const usedPercent = percent(buckets.autoPercentUsed);
  if (usedPercent === undefined) return null;
  const end =
    typeof data.billingCycleEnd === "string" || typeof data.billingCycleEnd === "number"
      ? Number(data.billingCycleEnd)
      : NaN;
  const date = new Date(end);
  const resetsAt = Number.isFinite(date.getTime()) && end > 0 ? date.toISOString() : undefined;
  const apiPercent = percent(buckets.apiPercentUsed);
  const email = record(identity).email;
  const planName = record(record(plan).planInfo).planName;
  const result = harnessAccountSnapshotSchema.safeParse({
    ...(typeof email === "string" && email.trim() ? { email } : {}),
    ...(typeof planName === "string" && planName.trim() ? { plan: planName } : {}),
    credits: {
      usedPercent,
      label: "Auto · monthly",
      periodType: "monthly",
      ...(resetsAt ? { resetsAt } : {}),
      ...(apiPercent === undefined
        ? {}
        : {
            productUsage: [
              {
                product: "API · monthly",
                usagePercent: apiPercent,
                ...(resetsAt ? { resetsAt } : {}),
              },
            ],
          }),
    },
  });
  return result.success ? result.data : null;
}

async function accessToken(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (environment.CURSOR_API_KEY?.trim() || environment.AGENT_CLI_CREDENTIAL_STORE === "memory")
    return undefined;
  if (process.platform === "darwin" && environment.AGENT_CLI_CREDENTIAL_STORE !== "file") {
    const result = await execute(
      "/usr/bin/security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return result.stdout.trim() || undefined;
  }
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const authPath =
    process.platform === "darwin"
      ? path.join(home, ".cursor", "auth.json")
      : process.platform === "win32"
        ? path.join(
            environment.APPDATA ?? path.join(home, "AppData", "Roaming"),
            "Cursor",
            "auth.json",
          )
        : path.join(
            environment.XDG_CONFIG_HOME ?? path.join(home, ".config"),
            "cursor",
            "auth.json",
          );
  const auth = record(JSON.parse(await readFile(authPath, "utf8")));
  return typeof auth.accessToken === "string" && auth.accessToken.trim()
    ? auth.accessToken
    : undefined;
}

export async function fetchCursorAccount(
  input: {
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    readAccessToken?: () => Promise<string | undefined>;
  } = {},
): Promise<HarnessAccountSnapshot | null> {
  try {
    const environment = input.environment ?? process.env;
    if (environment.CURSOR_API_KEY?.trim() || environment.AGENT_CLI_CREDENTIAL_STORE === "memory")
      return null;
    const token = await (input.readAccessToken
      ? input.readAccessToken()
      : accessToken(environment));
    if (!token) return null;
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const request = async (method: string): Promise<unknown> => {
      const response = await (input.fetch ?? fetch)(ENDPOINT + method, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
        signal,
      });
      return response.ok ? response.json() : null;
    };
    const [usage, identity, plan] = await Promise.all([
      request("GetCurrentPeriodUsage"),
      request("GetMe").catch(() => null),
      request("GetPlanInfo").catch(() => null),
    ]);
    return projectCursorAccountUsage(usage, identity, plan);
  } catch {
    return null;
  }
}
