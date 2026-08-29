import { execFileSync } from "node:child_process";
import path from "node:path";

export const LINUX_GLIBC_BASELINE = "2.35";

export const LINUX_NATIVE_EXECUTABLES = Object.freeze([
  "bin/codexhost",
  "libexec/codexhost-shim",
  "libexec/codexhost-updater",
]);

function compareVersion(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function glibcVersionsFromObjdump(output) {
  return [
    ...new Set([...output.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)].map((match) => match[1])),
  ].sort(compareVersion);
}

export function verifyLinuxGlibcBaseline({
  packageRoot,
  baseline = LINUX_GLIBC_BASELINE,
  inspect = (binary) => execFileSync("objdump", ["-T", binary], { encoding: "utf8" }),
}) {
  return LINUX_NATIVE_EXECUTABLES.map((relative) => {
    const binary = path.join(packageRoot, ...relative.split("/"));
    const versions = glibcVersionsFromObjdump(inspect(binary));
    const maximum = versions.at(-1);
    if (!maximum) {
      throw new Error(`Linux native executable has no GLIBC symbol versions: ${relative}`);
    }
    if (compareVersion(maximum, baseline) > 0) {
      throw new Error(
        `Linux native executable ${relative} requires GLIBC_${maximum}, exceeding the GLIBC_${baseline} release baseline`,
      );
    }
    return { relative, maximum };
  });
}
