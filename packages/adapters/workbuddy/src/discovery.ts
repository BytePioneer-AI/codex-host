import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import {
  harnessCandidates,
  targetPath,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export const WORKBUDDY_MACOS_ELECTRON = "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron";
export const WORKBUDDY_MACOS_CLI =
  "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

/** Explicit command / install-directory override, aligned with CODEXHOST_QODER_COMMAND. */
export const CODEXHOST_WORKBUDDY_COMMAND = "CODEXHOST_WORKBUDDY_COMMAND";

const windowsRoots = [
  "${LOCALAPPDATA}/Programs/WorkBuddy AI",
  "${LOCALAPPDATA}/Programs/WorkBuddy",
  "${LOCALAPPDATA}/Programs/WorkBuddyAI",
  "${LOCALAPPDATA}/WorkBuddy AI",
  "${LOCALAPPDATA}/WorkBuddy",
  "${LOCALAPPDATA}/WorkBuddyAI",
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

const WORKBUDDY_EXE_BASENAME = /^(?:WorkBuddy|WorkBuddy AI|WorkBuddyAI)\.exe$/iu;
const WORKBUDDY_PRODUCT = /WorkBuddy(?:\s*AI|AI)?/iu;

const UNINSTALL_REGISTRY_ROOTS = [
  // Prefer HKCU first so a per-user install can short-circuit before HKLM scans.
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const;

export interface WorkBuddyDiscoveryDependencies {
  /** Optional Windows install EXE candidates (DisplayIcon / Start Menu). */
  readonly windowsInstallExecutables?: () => string[];
}

/** Parse uninstall DisplayIcon values such as `"C:\\path\\WorkBuddyAI.exe",0`. */
export function parseWindowsDisplayIcon(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const quoted = trimmed.match(/^"(?<path>[^"]+\.exe)"(?:\s*,\s*-?\d+)?$/iu);
  if (quoted?.groups?.path) return quoted.groups.path.trim();
  const bare = trimmed.match(/^(?<path>[^,]+?\.exe)(?:\s*,\s*-?\d+)?$/iu);
  return bare?.groups?.path?.trim();
}

/**
 * Minimal Shell Link (.lnk) LocalBasePath reader. Returns undefined when the
 * shortcut has no local path or the file is not a recognizable link.
 */
export function readWindowsShortcutTarget(filePath: string): string | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return undefined;
  }
  if (buffer.length < 0x4c) return undefined;
  if (buffer.readUInt32LE(0) !== 0x4c) return undefined;
  const linkFlags = buffer.readUInt32LE(0x14);
  let offset = buffer.readUInt32LE(0);
  if (linkFlags & 0x01) {
    if (offset + 2 > buffer.length) return undefined;
    const idListSize = buffer.readUInt16LE(offset);
    offset += 2 + idListSize;
  }
  if (!(linkFlags & 0x02)) return undefined;
  if (offset + 0x1c > buffer.length) return undefined;
  const linkInfoSize = buffer.readUInt32LE(offset);
  if (linkInfoSize < 0x1c || offset + linkInfoSize > buffer.length) return undefined;
  const linkInfoHeaderSize = buffer.readUInt32LE(offset + 4);
  const linkInfoFlags = buffer.readUInt32LE(offset + 8);
  if (!(linkInfoFlags & 0x01)) return undefined;
  if (linkInfoHeaderSize >= 0x24) {
    const unicodeOffset = buffer.readUInt32LE(offset + 0x1c);
    if (unicodeOffset > 0 && unicodeOffset < linkInfoSize) {
      const path = readNullTerminatedUtf16(buffer, offset + unicodeOffset, offset + linkInfoSize);
      if (path) return path;
    }
  }
  const localBasePathOffset = buffer.readUInt32LE(offset + 0x10);
  if (localBasePathOffset <= 0 || localBasePathOffset >= linkInfoSize) return undefined;
  return readNullTerminatedAnsi(buffer, offset + localBasePathOffset, offset + linkInfoSize);
}

/**
 * Discover WorkBuddy Desktop EXE paths from uninstall DisplayIcon values and
 * Start Menu shortcuts. Used when standard install roots miss a custom path.
 * Only runs on win32; prefer injecting via WorkBuddyDiscoveryDependencies in tests.
 */
export function listWindowsInstallExecutables(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (process.platform !== "win32") return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate) return;
    const trimmed = candidate.trim();
    if (!WORKBUDDY_EXE_BASENAME.test(targetPath("win32").basename(trimmed))) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(trimmed);
  };
  for (const candidate of listUninstallDisplayIconExecutables()) add(candidate);
  for (const candidate of listStartMenuShortcutExecutables(environment)) add(candidate);
  return found;
}

/** Resolve only within the selected installation; never search PATH or another installation. */
export function resolveWorkBuddyInstallDirectory(
  directory: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isExecutable: (candidate: string) => boolean,
  dependencies: WorkBuddyDiscoveryDependencies = {},
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
      dependencies,
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
  dependencies: WorkBuddyDiscoveryDependencies = {},
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
    const bundle = pairWorkBuddyExecutable(candidate, platform, isExecutable);
    if (bundle) return bundle;
  }

  if (!explicitExecutable && platform === "win32") {
    const installs =
      dependencies.windowsInstallExecutables?.() ?? listWindowsInstallExecutables(environment);
    for (const candidate of installs) {
      if (paths.extname(candidate).toLowerCase() !== ".exe") continue;
      if (!WORKBUDDY_EXE_BASENAME.test(paths.basename(candidate))) continue;
      const bundle = pairWorkBuddyExecutable(candidate, platform, isExecutable);
      if (bundle) return bundle;
    }
  }
  return undefined;
}

function pairWorkBuddyExecutable(
  candidate: string,
  platform: NodeJS.Platform,
  isExecutable: (path: string) => boolean,
): { executable: string; cli: string } | undefined {
  if (!isExecutable(candidate)) return undefined;
  const paths = targetPath(platform);
  const resources =
    platform === "darwin"
      ? paths.resolve(paths.dirname(candidate), "..", "Resources")
      : paths.join(paths.dirname(candidate), "resources");
  const cli = paths.join(resources, "app.asar.unpacked", "cli", "bin", "codebuddy");
  if (!isExecutable(cli)) return undefined;
  return { executable: candidate, cli };
}

function listUninstallDisplayIconExecutables(): string[] {
  const found: string[] = [];
  for (const root of UNINSTALL_REGISTRY_ROOTS) {
    let output = "";
    try {
      output = execFileSync("reg.exe", ["query", root, "/s", "/v", "DisplayIcon"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 2_000,
      });
    } catch {
      continue;
    }
    found.push(...parseUninstallRegistryOutput(output));
    // Stop after the first hive that yields a WorkBuddy EXE (avoid 4× ~2s worst case).
    if (found.length > 0) return found;
  }
  return found;
}

/** Collect DisplayIcon EXE paths for WorkBuddy uninstall entries. */
export function parseUninstallRegistryOutput(output: string): string[] {
  const found: string[] = [];
  let displayName = "";
  let displayIcon = "";
  const flush = () => {
    if (
      displayIcon &&
      (WORKBUDDY_PRODUCT.test(displayName) || WORKBUDDY_PRODUCT.test(displayIcon))
    ) {
      const parsed = parseWindowsDisplayIcon(displayIcon);
      if (parsed) found.push(parsed);
    }
    displayName = "";
    displayIcon = "";
  };
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^HKEY_/iu.test(line)) {
      flush();
      continue;
    }
    const nameMatch = line.match(/^DisplayName\s+REG_\w+\s+(.*)$/iu);
    if (nameMatch) {
      displayName = (nameMatch[1] ?? "").trim();
      continue;
    }
    const iconMatch = line.match(/^DisplayIcon\s+REG_\w+\s+(.*)$/iu);
    if (iconMatch) {
      displayIcon = (iconMatch[1] ?? "").trim();
    }
  }
  flush();
  return found;
}

function listStartMenuShortcutExecutables(environment: NodeJS.ProcessEnv): string[] {
  const paths = targetPath("win32");
  const roots = [
    environment.PROGRAMDATA &&
      paths.join(environment.PROGRAMDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
    environment.APPDATA &&
      paths.join(environment.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
  ].filter((root): root is string => Boolean(root));
  const found: string[] = [];
  for (const root of roots) {
    for (const shortcut of listShortcutFiles(root, 6)) {
      const base = paths.basename(shortcut);
      const target = readWindowsShortcutTarget(shortcut);
      if (!target) continue;
      if (!WORKBUDDY_PRODUCT.test(base) && !WORKBUDDY_PRODUCT.test(target)) continue;
      if (!WORKBUDDY_EXE_BASENAME.test(paths.basename(target))) continue;
      found.push(target);
    }
  }
  return found;
}

function listShortcutFiles(directory: string, depth: number): string[] {
  if (depth < 0) return [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  const paths = targetPath("win32");
  for (const entry of entries) {
    const full = paths.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listShortcutFiles(full, depth - 1));
      continue;
    }
    if (entry.isFile() && /\.lnk$/iu.test(entry.name)) found.push(full);
  }
  return found;
}

function readNullTerminatedAnsi(buffer: Buffer, start: number, end: number): string | undefined {
  let cursor = start;
  while (cursor < end && buffer[cursor] !== 0) cursor += 1;
  if (cursor === start) return undefined;
  return buffer.subarray(start, cursor).toString("utf8");
}

function readNullTerminatedUtf16(buffer: Buffer, start: number, end: number): string | undefined {
  const chars: number[] = [];
  for (let cursor = start; cursor + 1 < end; cursor += 2) {
    const code = buffer.readUInt16LE(cursor);
    if (code === 0) break;
    chars.push(code);
  }
  if (chars.length === 0) return undefined;
  return String.fromCharCode(...chars);
}
