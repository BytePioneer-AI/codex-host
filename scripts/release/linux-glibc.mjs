import { execFileSync } from "node:child_process";
import path from "node:path";

// Matches the official Node.js 22 Linux binaries, so it excludes no system that can run the Host.
export const LINUX_GLIBC_BASELINE = "2.28";

// AlmaLinux 8 ships glibc 2.28. The multi-architecture index digest serves both x64 and ARM64.
export const LINUX_GLIBC_BASELINE_IMAGE =
  "almalinux:8@sha256:8b469a3a78515e8a18ea8fc727e6a3679e1d0c5ba6f58d5b30be3d0d9b86cffe";

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

function packagedExecutable(packageRoot, relative) {
  return path.join(packageRoot, ...relative.split("/"));
}

// cargo-zigbuild links against the glibc named by the target suffix, independent of the build
// host. Zig turns the linker's --strip-debug into a full strip, so Cargo's default release strip
// is disabled here and stripLinuxDebugInfo removes only debug sections afterwards, keeping the
// symbol table that panic backtraces use. Output still lands in target/<rustTarget>/release.
export function linuxGlibcCargoArguments(rustTarget) {
  return [
    "zigbuild",
    "--config",
    'profile.release.strip="none"',
    "--target",
    `${rustTarget}.${LINUX_GLIBC_BASELINE}`,
  ];
}

export function stripLinuxDebugInfo({
  packageRoot,
  strip = (binary) => execFileSync("objcopy", ["--strip-debug", binary], { stdio: "inherit" }),
}) {
  for (const relative of LINUX_NATIVE_EXECUTABLES) {
    strip(packagedExecutable(packageRoot, relative));
  }
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
    const versions = glibcVersionsFromObjdump(inspect(packagedExecutable(packageRoot, relative)));
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

// The symbol-version check above cannot see every loader requirement (for example
// GLIBC_ABI_DT_RELR), so the dynamic loader of a real baseline system resolves each executable.
// ldd exits 0 even when a version or library is missing, so its report is checked instead.
export function verifyLinuxGlibcLoad({
  packageRoot,
  image = LINUX_GLIBC_BASELINE_IMAGE,
  trace = (binaries) =>
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${packageRoot}:/package:ro`,
        image,
        "sh",
        "-c",
        'ldd "$@" 2>&1',
        "ldd",
        ...binaries,
      ],
      { encoding: "utf8" },
    ),
}) {
  const report = trace(LINUX_NATIVE_EXECUTABLES.map((relative) => `/package/${relative}`));
  const failures = report.split("\n").filter((line) => line.includes("not found"));
  if (failures.length > 0) {
    throw new Error(
      `Linux native executables cannot load on ${image}:\n${failures.map((line) => line.trim()).join("\n")}`,
    );
  }
}
