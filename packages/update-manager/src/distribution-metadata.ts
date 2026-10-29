import type { ReleaseTarget } from "./github-release.js";
import { requireSemanticVersion } from "./status.js";

export interface DistributionMetadata {
  schemaVersion: 1;
  version: string;
  distribution: "npm" | "installer";
  target: ReleaseTarget;
}

export function parseDistributionMetadata(value: unknown): DistributionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("distribution metadata must be an object");
  }
  const metadata = value as Record<string, unknown>;
  const allowed = ["distribution", "schemaVersion", "target", "version"];
  if (Object.keys(metadata).some((key) => !allowed.includes(key))) {
    throw new Error("distribution metadata contains unknown fields");
  }
  if (
    metadata.schemaVersion !== 1 ||
    (metadata.distribution !== "npm" && metadata.distribution !== "installer") ||
    ![
      "macos-arm64",
      "macos-x64",
      "windows-x64",
      "windows-arm64",
      "linux-x64",
      "linux-arm64",
    ].includes(String(metadata.target)) ||
    typeof metadata.version !== "string"
  )
    throw new Error("distribution metadata is invalid");
  return {
    schemaVersion: 1,
    version: requireSemanticVersion(metadata.version),
    distribution: metadata.distribution,
    target: metadata.target as ReleaseTarget,
  };
}
