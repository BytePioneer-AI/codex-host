import { auditedAppInitialAssetPresent } from "./renderer-cpa-live-voice-hook.js";

interface VoiceAssets {
  version: string;
  initial: string;
  shared: string;
}

export function supportsVoiceVersion(profiles: readonly VoiceAssets[], version?: string): boolean {
  return version === undefined || profiles.some((profile) => profile.version === version);
}

/** Select one complete audited pair; version metadata cannot excuse mixed assets. */
export function selectVoiceAssets<T extends VoiceAssets>(
  profiles: readonly T[],
  names: readonly string[],
  version?: string,
): T | undefined {
  const present = profiles.filter((profile) =>
    [profile.initial, profile.shared].some((asset) => auditedAppInitialAssetPresent(names, asset)),
  );
  const profile = present.length === 1 ? present[0] : undefined;
  return profile &&
    (version === undefined || profile.version === version) &&
    [profile.initial, profile.shared].every((asset) => auditedAppInitialAssetPresent(names, asset))
    ? profile
    : undefined;
}
