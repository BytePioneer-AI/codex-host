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
): { executable: string; cli: string } | undefined {
  const specs: HarnessDiscoverySpec[] =
    platform === "darwin"
      ? [macSpec]
      : platform === "win32"
        ? ["WorkBuddy AI", "WorkBuddy", "WorkBuddyAI"].map((command) => ({
            id: "workbuddy",
            command,
            installRoots: { windows: windowsRoots },
          }))
        : [];
  const paths = targetPath(platform);
  const candidates = explicitExecutable
    ? [{ candidate: explicitExecutable, source: "configured" as const }]
    : specs.flatMap((spec) => harnessCandidates(spec, { environment, platform }));
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
