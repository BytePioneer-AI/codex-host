import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  harnessCandidates,
  targetPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const WORKBUDDY_MACOS_ELECTRON = "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron";
export const WORKBUDDY_MACOS_CLI =
  "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

const windowsRoots = [
  "${LOCALAPPDATA}/Programs/WorkBuddy AI",
  "${LOCALAPPDATA}/Programs/WorkBuddy",
  "${LOCALAPPDATA}/Programs/WorkBuddyAI",
  "${ProgramFiles}/WorkBuddy AI",
  "${ProgramFiles}/WorkBuddy",
  "${ProgramFiles}/WorkBuddyAI",
];

const macSpec: HarnessDiscoverySpec = {
  id: "workbuddy",
  command: "Electron",
  installRoots: {
    posix: [
      "/Applications/WorkBuddy AI.app/Contents/MacOS",
      "/Applications/WorkBuddy.app/Contents/MacOS",
      "~/Applications/WorkBuddy AI.app/Contents/MacOS",
      "~/Applications/WorkBuddy.app/Contents/MacOS",
    ],
  },
};

export interface MacWorkBuddyScanDependencies {
  readdirSync?: typeof readdirSync;
  statSync?: typeof statSync;
  roots?: readonly string[];
}

export type MacWorkBuddyScanFunctions = Required<Omit<MacWorkBuddyScanDependencies, "roots">>;

const defaultScanDependencies = (): Required<Omit<MacWorkBuddyScanDependencies, "roots">> => ({
  readdirSync,
  statSync,
});

/**
 * Auto-updates and bundle migrations rename the .app directory, so fixed
 * canonical install roots miss renamed or staged copies. Every "WorkBuddy*.app"
 * bundle under the standard Applications roots is a candidate; canonical names
 * win first, then the most recently placed copy wins over stale ones.
 */
export function macWorkBuddyAppBundleDirectories(
  platform: NodeJS.Platform = process.platform,
  scan: MacWorkBuddyScanDependencies = {},
): string[] {
  if (platform !== "darwin") return [];
  const paths = targetPath(platform);
  const { readdirSync: list, statSync: metadata } = {
    ...defaultScanDependencies(),
    ...scan,
  };
  const roots = scan.roots ?? ["/Applications", paths.join(homedir(), "Applications")];
  const bundles = new Map<string, number>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = list(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^WorkBuddy[ .\w-]*\.app$/iu.test(entry)) continue;
      const bundle = paths.join(root, entry);
      try {
        metadata(paths.join(bundle, "Contents", "Info.plist"));
        metadata(paths.join(bundle, "Contents", "MacOS"));
        bundles.set(bundle, metadata(bundle).mtimeMs);
      } catch {
        continue;
      }
    }
  }
  const canonical = (bundle: string): number =>
    /\/WorkBuddy(?: AI)?\.app$/iu.test(bundle) ? 1 : 0;
  const scored = [...bundles].map(([bundle, mtime]) => ({
    bundle,
    rank: canonical(bundle) * 1e12 + mtime,
  }));
  return scored.sort((left, right) => right.rank - left.rank).map((entry) => entry.bundle);
}

/** Resolve only within the selected installation; never search PATH or another installation. */
export function resolveWorkBuddyInstallDirectory(
  directory: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isExecutable: (candidate: string) => boolean,
): { executable: string; cli: string } | undefined {
  const paths = targetPath(platform);
  const entries =
    platform === "win32"
      ? ["WorkBuddy.exe", "WorkBuddy AI.exe", "WorkBuddyAI.exe"]
      : platform === "darwin"
        ? [paths.join("Contents", "MacOS", "Electron")]
        : [];
  for (const entry of entries) {
    const bundle = resolveWorkBuddyBundle(
      environment,
      platform,
      isExecutable,
      paths.join(directory, entry),
    );
    if (bundle) return bundle;
  }
  return undefined;
}

/** Discover app-owned runtime/script pairs; an unrelated PATH CodeBuddy is never a candidate. */
export function resolveWorkBuddyBundle(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isExecutable: (candidate: string) => boolean,
  explicitExecutable?: string,
  scan: MacWorkBuddyScanDependencies = {},
): { executable: string; cli: string } | undefined {
  const paths = targetPath(platform);
  const candidates = explicitExecutable
    ? [{ candidate: explicitExecutable, source: "configured" as const }]
    : platform === "darwin"
      ? [
          ...specsFor(platform).flatMap((spec) =>
            harnessCandidates(spec, { environment, platform }),
          ),
          // Renamed/staged app bundles (update migrations) that the fixed roots miss.
          ...macWorkBuddyAppBundleDirectories(platform, scan).map((bundle) => ({
            candidate: paths.join(bundle, "Contents", "MacOS", "Electron"),
            source: "install-root" as const,
          })),
        ]
      : specsFor(platform).flatMap((spec) => harnessCandidates(spec, { environment, platform }));
  for (const { candidate, source } of candidates) {
    // A random Electron on PATH is not WorkBuddy; Windows .cmd shims are not Electron runtimes.
    if (platform === "darwin" && source !== "install-root" && !explicitExecutable) continue;
    if (platform === "win32" && paths.extname(candidate).toLowerCase() !== ".exe") continue;
    if (!isExecutable(candidate)) continue;
    const resources =
      platform === "darwin"
        ? paths.resolve(paths.dirname(candidate), "..", "Resources")
        : paths.join(paths.dirname(candidate), "resources");
    const cli = paths.join(resources, "app.asar.unpacked", "cli", "bin", "codebuddy");
    if (isExecutable(cli)) return { executable: candidate, cli };
  }
  return undefined;
}

function specsFor(platform: NodeJS.Platform): HarnessDiscoverySpec[] {
  if (platform === "darwin") return [macSpec];
  if (platform === "win32")
    return ["WorkBuddy AI", "WorkBuddy", "WorkBuddyAI"].map((command) => ({
      id: "workbuddy",
      command,
      installRoots: { windows: windowsRoots },
    }));
  return [];
}
