import path from "node:path";

const FIELDS = ["platform", "version", "build", "asarIntegrity"];
const SHA256 = /^sha256:[0-9a-f]{64}$/;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const identityKey = (value) => JSON.stringify(FIELDS.map((field) => value[field]));

function requireScalar(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export function parseReviewedDesktopManifest(value, manifestDirectory) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.desktops) || value.desktops.length === 0) {
    throw new Error("invalid reviewed desktop manifest: schemaVersion 1 and non-empty desktops required");
  }
  for (let index = 0; index < value.desktops.length; index += 1) {
    if (!Object.hasOwn(value.desktops, index)) throw new Error("desktop entries must not be sparse");
  }
  if (typeof manifestDirectory !== "string" || manifestDirectory.length === 0) {
    throw new Error("manifestDirectory must be a non-empty string");
  }

  const root = path.resolve(manifestDirectory);
  const identities = new Set();
  const desktops = value.desktops.map((entry) => {
    if (!isRecord(entry)) throw new Error("desktop entry must be an object");
    for (const field of FIELDS) requireScalar(entry[field], field);
    if (!SHA256.test(entry.asarIntegrity)) throw new Error("asarIntegrity must be lowercase sha256");
    requireScalar(entry.baseline, "baseline");
    if (path.isAbsolute(entry.baseline)) throw new Error("baseline path must be confined");
    const baseline = path.resolve(root, entry.baseline);
    const relative = path.relative(root, baseline);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("baseline path must be confined to manifestDirectory");
    }
    const key = identityKey(entry);
    if (identities.has(key)) throw new Error("duplicate reviewed desktop identity");
    identities.add(key);
    return { ...entry, baseline };
  });
  return { schemaVersion: 1, desktops };
}

export function findReviewedDesktop(manifest, identity) {
  const match = manifest?.desktops?.find(
    (entry) => FIELDS.every((field) => entry[field] === identity?.[field]),
  );
  if (!match) throw new Error("desktop identity is not reviewed");
  return match;
}
