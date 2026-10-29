export const STATUS_SCHEMA_VERSION = 1;
export const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type BackgroundUpdateInstallation = "npm" | "windows-installer" | "macos-dmg";
export type BackgroundUpdatePhase =
  | "prepared"
  | "downloading"
  | "waiting-for-exit"
  | "installing"
  | "restarting"
  | "succeeded"
  | "failed";

export interface BackgroundUpdateStatus {
  schemaVersion: 1;
  version: string;
  installation: BackgroundUpdateInstallation;
  phase: BackgroundUpdatePhase;
  updatedAt: number;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
  outcome?: "updated" | "restored" | "recovery-failed" | "unknown";
  restart?: {
    installationRoot: string;
    launcherPid: number;
    launcherStartedAtMicros: string;
    version: string;
  };
}

export function requireSemanticVersion(value: string): string {
  if (!SEMVER_PATTERN.test(value)) throw new Error("update version must be valid semantic version");
  return value;
}

export function preparedStatus(
  version: string,
  installation: BackgroundUpdateInstallation,
  now: number,
): BackgroundUpdateStatus {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    version,
    installation,
    phase: "prepared",
    updatedAt: Math.floor(now / 1000),
  };
}

export function parseUpdateStatus(value: unknown): BackgroundUpdateStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("background update status must be an object");
  }
  const status = value as Record<string, unknown>;
  const allowed = [
    "downloadedBytes",
    "error",
    "installation",
    "phase",
    "schemaVersion",
    "totalBytes",
    "updatedAt",
    "version",
    "outcome",
    "restart",
  ];
  if (Object.keys(status).some((key) => !allowed.includes(key))) {
    throw new Error("background update status contains unknown fields");
  }
  if (
    status.schemaVersion !== STATUS_SCHEMA_VERSION ||
    typeof status.version !== "string" ||
    !SEMVER_PATTERN.test(status.version) ||
    !["npm", "windows-installer", "macos-dmg"].includes(String(status.installation)) ||
    ![
      "prepared",
      "downloading",
      "waiting-for-exit",
      "installing",
      "restarting",
      "succeeded",
      "failed",
    ].includes(String(status.phase)) ||
    !Number.isSafeInteger(status.updatedAt) ||
    (status.downloadedBytes !== undefined &&
      (typeof status.downloadedBytes !== "number" ||
        !Number.isSafeInteger(status.downloadedBytes) ||
        status.downloadedBytes < 0)) ||
    (status.totalBytes !== undefined &&
      (typeof status.totalBytes !== "number" ||
        !Number.isSafeInteger(status.totalBytes) ||
        status.totalBytes <= 0)) ||
    (typeof status.downloadedBytes === "number" &&
      typeof status.totalBytes === "number" &&
      status.downloadedBytes > status.totalBytes) ||
    (status.error !== undefined && typeof status.error !== "string")
  ) {
    throw new Error("background update status is invalid");
  }
  if (
    status.outcome !== undefined &&
    (!["updated", "restored", "recovery-failed", "unknown"].includes(String(status.outcome)) ||
      (status.outcome === "updated" ? status.phase !== "succeeded" : status.phase !== "failed"))
  )
    throw new Error("invalid update outcome");
  if (status.restart !== undefined) {
    const r = status.restart as Record<string, unknown>;
    if (
      !r ||
      typeof r !== "object" ||
      Object.keys(r).some(
        (k) =>
          !["installationRoot", "launcherPid", "launcherStartedAtMicros", "version"].includes(k),
      ) ||
      typeof r.installationRoot !== "string" ||
      !Number.isSafeInteger(r.launcherPid) ||
      Number(r.launcherPid) <= 0 ||
      typeof r.launcherStartedAtMicros !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(r.launcherStartedAtMicros) ||
      typeof r.version !== "string" ||
      !SEMVER_PATTERN.test(r.version)
    )
      throw new Error("invalid update restart binding");
  }
  return status as unknown as BackgroundUpdateStatus;
}
