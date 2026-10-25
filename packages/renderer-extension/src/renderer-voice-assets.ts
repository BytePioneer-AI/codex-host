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
  if (version !== undefined) {
    const profile = profiles.find((entry) => entry.version === version);
    if (!profile) return undefined;
    if (present.some((entry) => entry.version !== version)) return undefined;
    const complete = [profile.initial, profile.shared].every((asset) =>
      auditedAppInitialAssetPresent(names, asset),
    );
    return complete || present.length === 0 ? profile : undefined;
  }
  const profile = present.length === 1 ? present[0] : undefined;
  return profile &&
    [profile.initial, profile.shared].every((asset) => auditedAppInitialAssetPresent(names, asset))
    ? profile
    : undefined;
}
