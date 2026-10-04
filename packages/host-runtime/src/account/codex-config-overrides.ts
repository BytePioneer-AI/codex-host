import { parse } from "smol-toml";

/** The startup values that decide whether, and from which source, a tier catalog is prepared. */
export interface CodexStartupCatalogConfig {
  readonly model_provider?: unknown;
  readonly model_catalog_json?: unknown;
  /** Selected legacy profile that supplied the effective `model_catalog_json`, when one did. */
  readonly catalogProfileName?: string;
}

const RELEVANT_KEYS = ["model_provider", "model_catalog_json"] as const;
type RelevantKey = (typeof RELEVANT_KEYS)[number];
type RelevantValues = Partial<Record<RelevantKey, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRelevantKey(key: string | undefined): key is RelevantKey {
  return (RELEVANT_KEYS as readonly (string | undefined)[]).includes(key);
}

function pickRelevant(source: unknown): RelevantValues {
  const picked: RelevantValues = {};
  if (!isRecord(source)) return picked;
  for (const key of RELEVANT_KEYS) if (key in source) picked[key] = source[key];
  return picked;
}

/**
 * Codex CLI `-c key=value` semantics: split at the first `=`, split the key on `.`,
 * parse the value as a TOML value and fall back to the literal string. Keys are
 * never parsed as TOML, so segments such as `codex-app-tools@openai-bundled` are valid.
 */
export function parseCodexConfigOverride(
  raw: string,
): { readonly path: readonly string[]; readonly value: unknown } | null {
  const separator = raw.indexOf("=");
  if (separator <= 0) return null;
  const path = raw
    .slice(0, separator)
    .trim()
    .split(".")
    .map((segment) => segment.trim());
  if (path.some((segment) => segment.length === 0)) return null;
  const source = raw.slice(separator + 1).trim();
  let value: unknown = source;
  try {
    value = parse(`value = ${source}`).value;
  } catch {
    // Codex treats an unparsable value as a literal string.
  }
  return { path, value };
}

/**
 * Resolve only the startup keys the tier catalog depends on: `config.toml` with `-c`
 * overrides applied, then the selected legacy profile on top. Unrelated or malformed
 * overrides are skipped instead of failing the whole startup; `catalogProfileName` records
 * which legacy profile layer supplied the effective catalog.
 */
export function resolveCodexStartupCatalogConfig(
  config: Record<string, unknown>,
  args: readonly string[],
): CodexStartupCatalogConfig {
  const root: RelevantValues = pickRelevant(config);
  const profiles = new Map<string, RelevantValues>();
  if (isRecord(config.profiles)) {
    for (const [name, profile] of Object.entries(config.profiles)) {
      profiles.set(name, pickRelevant(profile));
    }
  }
  let profile: unknown = config.profile;
  let profileFlag: string | undefined;

  const applyOverride = (raw: string | undefined): void => {
    if (!raw) return;
    const override = parseCodexConfigOverride(raw);
    if (!override) return;
    const [head, name, key, ...rest] = override.path;
    if (name === undefined) {
      if (head === "profile") profile = override.value;
      else if (isRelevantKey(head)) root[head] = override.value;
      else if (head === "profiles" && isRecord(override.value)) {
        profiles.clear();
        for (const [entry, value] of Object.entries(override.value)) {
          profiles.set(entry, pickRelevant(value));
        }
      }
      return;
    }
    if (head !== "profiles") return;
    if (key === undefined) {
      if (isRecord(override.value)) profiles.set(name, pickRelevant(override.value));
      return;
    }
    if (rest.length === 0 && isRelevantKey(key)) {
      profiles.set(name, { ...profiles.get(name), [key]: override.value });
    }
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--profile" || arg === "-p") profileFlag = args[++index];
    else if (arg.startsWith("--profile=")) profileFlag = arg.slice("--profile=".length);
    else if (arg === "--config" || arg === "-c") applyOverride(args[++index]);
    else if (arg.startsWith("--config=")) applyOverride(arg.slice("--config=".length));
  }

  const selected = profileFlag ?? profile;
  const fromProfile = typeof selected === "string" ? profiles.get(selected) : undefined;
  return {
    ...root,
    ...fromProfile,
    // The profile layer wins over the root when it defines the key, matching Codex's
    // legacy profile precedence; the name lets catalog preparation mirror the same layer.
    ...(typeof selected === "string" && fromProfile?.model_catalog_json !== undefined
      ? { catalogProfileName: selected }
      : {}),
  };
}
