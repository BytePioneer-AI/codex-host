import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDnsLabel, normalizeControlHost } from "./protocol.js";
import type { RegistrationRequest, RegistrationResult } from "./registration.js";

/** Self-hosted CLI names stay reserved to the signing identity across reconnects and restarts. */
export function selfHostedNames(dataDir: string, domain: string, controlHost: string) {
  const file = join(dataDir, "names.json");
  const owners = new Map<string, string>(
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [],
  );
  const suffix = normalizeControlHost(domain);
  const control = normalizeControlHost(controlHost);
  return ({ id, name }: RegistrationRequest): RegistrationResult => {
    const requested = (name || id).toLowerCase();
    if (
      !isDnsLabel(requested) ||
      `${requested}.${suffix}` === control ||
      // Public-key-derived addresses cannot be claimed by another identity as a custom name.
      (/^[a-z2-7]{26}$/.test(requested) && requested !== id) ||
      (owners.has(requested) && owners.get(requested) !== id)
    )
      return { reject: "name-taken" };
    if (!owners.has(requested)) {
      const next = new Map(owners).set(requested, id);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify([...next]), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      owners.set(requested, id);
    }
    return { name: requested };
  };
}
