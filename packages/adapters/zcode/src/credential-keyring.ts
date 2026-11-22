import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SERVICE = "ZCode Credential Encryption";
const KEYCHAIN_PASSWORD_TIMEOUT_MS = 30_000;
export class KeychainReadTimeout extends Error {}
export class KeychainAccessDeferred extends Error {}
export interface ReadSystemKeyOptions {
  access?: "allow" | "retry";
  /** A retry cannot override an attempt that completed after this gesture started. */
  requestedAt?: number;
  /** Minimum intent required when the caller skipped a read. */
  skipped?: "allow" | "retry";
}
export type ReadSystemKey = (
  account: string,
  options?: ReadSystemKeyOptions,
) => Promise<string | undefined>;

const cachedKeys = new Map<string, { value: string; readAt: number; mismatched?: boolean }>();
const deniedReads = new Map<string, { reason: "denied" | "timeout"; readAt: number }>();
const inFlightReads = new Map<string, Promise<string | undefined>>();

export function invalidateSystemCredentialKey(account: string, value: string): void {
  const key = `${process.platform}:${account}`;
  const cached = cachedKeys.get(key);
  if (cached?.value !== value) return;
  // A stale or damaged envelope must not open another Keychain prompt on a passive read.
  if (process.platform === "darwin") cached.mismatched = true;
  else cachedKeys.delete(key);
}

export function resetSystemCredentialKeyCache(): void {
  cachedKeys.clear();
  deniedReads.clear();
  inFlightReads.clear();
}

// @napi-rs/keyring 2.1.2 uses windows-native-keyring-store 1.1.0: its default generic
// target is `${user}.${service}` and passwords are stored as UTF-16LE (no terminator).
const WIN32_READER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ZCodeKeyReader {
  [StructLayout(LayoutKind.Sequential)]
  private struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
  }

  [DllImport("advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr result);

  [DllImport("advapi32.dll", ExactSpelling = true)]
  private static extern void CredFree(IntPtr credential);

  public static string Read(string target) {
    IntPtr result;
    if (!CredReadW(target, 1, 0, out result)) return null; // CRED_TYPE_GENERIC
    try {
      var credential = (Credential)Marshal.PtrToStructure(result, typeof(Credential));
      if (credential.Blob == IntPtr.Zero || credential.BlobSize != 86) return null;
      return Marshal.PtrToStringUni(credential.Blob, 43);
    } finally { CredFree(result); }
  }
}
'@
`;

/** Read one exact ZCode entry in the Host user's session. Never write or enumerate entries. */
export const readSystemCredentialKey: ReadSystemKey = async (account, options = {}) => {
  if (!/^[a-f0-9]{64}$/.test(account)) return;
  const cacheKey = `${process.platform}:${account}`;
  const existing = inFlightReads.get(cacheKey);
  if (existing) return existing;
  const mayRetry = (readAt: number) =>
    options.access === "retry" && (options.requestedAt ?? Infinity) >= readAt;
  const cached = cachedKeys.get(cacheKey);
  if (cached && (!cached.mismatched || !mayRetry(cached.readAt))) {
    if (cached.mismatched && options.access !== "retry") options.skipped = "retry";
    return cached.value;
  }
  const denied = deniedReads.get(cacheKey);
  if (denied && !mayRetry(denied.readAt)) {
    if (options.access !== "retry") options.skipped = "retry";
    if (denied.reason === "timeout") throw new KeychainReadTimeout();
    return undefined;
  }
  if (process.platform === "darwin" && !options.access) {
    options.skipped = "allow";
    throw new KeychainAccessDeferred();
  }
  cachedKeys.delete(cacheKey);
  deniedReads.delete(cacheKey);
  const read = (async (): Promise<string | undefined> => {
    const env = {
      ...process.env,
      ZCODE_CREDENTIAL_SECRET: undefined,
      ZCODE_CREDENTIAL_SECRET_FILE: undefined,
    };
    const run = async (file: string, args: string[], timeout = 5_000) =>
      (await execute(file, args, { env, timeout, maxBuffer: 4096, windowsHide: true })).stdout;
    try {
      let value: string | undefined;
      if (process.platform === "win32") {
        const root = process.env.SystemRoot;
        if (!root || !path.isAbsolute(root)) return;
        const powershell = path.join(
          root,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        // Encode the public script to preserve quoting through Windows argument parsing.
        const command = `${WIN32_READER}\n[Console]::Write([ZCodeKeyReader]::Read('${account}.${SERVICE}'))`;
        value = (
          await run(powershell, [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
          ])
        ).replace(/\r?\n$/, "");
      } else if (process.platform === "darwin") {
        const security = "/usr/bin/security";
        const keychain = /^\s*"([^"\r\n]+)"\s*$/.exec(
          await run(security, ["default-keychain", "-d", "user"]),
        )?.[1];
        if (!keychain || !path.isAbsolute(keychain)) {
          deniedReads.set(cacheKey, { reason: "denied", readAt: performance.now() });
          return;
        }
        // Unlike the lookup of the default path, reading the value can prompt the user.
        const raw = await run(
          security,
          ["find-generic-password", "-s", SERVICE, "-a", account, "-w", keychain],
          KEYCHAIN_PASSWORD_TIMEOUT_MS,
        ).catch((error: unknown) => {
          const failure = error as { killed?: boolean; code?: unknown; signal?: string } | null;
          if (failure?.killed && failure.code === null && failure.signal === "SIGTERM")
            throw new KeychainReadTimeout();
          return undefined;
        });
        value = raw?.replace(/\r?\n$/, "");
      } else if (process.platform === "linux") {
        // secret-tool does not append a newline to pipe output.
        value = await run("/usr/bin/secret-tool", [
          "lookup",
          "service",
          SERVICE,
          "username",
          account,
        ]);
      }
      if (value) {
        cachedKeys.set(cacheKey, { value, readAt: performance.now() });
        deniedReads.delete(cacheKey);
        return value;
      }
      deniedReads.set(cacheKey, { reason: "denied", readAt: performance.now() });
      return value;
    } catch (error) {
      // Child-process errors can carry stdout, stderr, and command details. Never forward them.
      if (error instanceof KeychainReadTimeout) {
        deniedReads.set(cacheKey, { reason: "timeout", readAt: performance.now() });
        throw error;
      }
      deniedReads.set(cacheKey, { reason: "denied", readAt: performance.now() });
    }
  })();
  inFlightReads.set(cacheKey, read);
  try {
    return await read;
  } finally {
    inFlightReads.delete(cacheKey);
  }
};
