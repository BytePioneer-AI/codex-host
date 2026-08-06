import { writeFile } from "node:fs/promises";

const semverPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const targetPattern = /^(?:macos|windows)-(?:arm64|x64)$/u;

export function createDistributionMetadata({ version, distribution, target }) {
  if (!semverPattern.test(version)) throw new Error("distribution version must be valid semver");
  if (distribution !== "installer" && distribution !== "npm") {
    throw new Error("distribution must be installer or npm");
  }
  if (!targetPattern.test(target)) throw new Error("distribution target is invalid");
  return {
    schemaVersion: 1,
    version,
    distribution,
    target,
  };
}

export async function writeDistributionMetadata(filePath, options) {
  const metadata = createDistributionMetadata(options);
  await writeFile(filePath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
  return metadata;
}
