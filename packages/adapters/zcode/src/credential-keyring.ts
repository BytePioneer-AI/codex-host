import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SERVICE = "ZCode Credential Encryption";
export type ReadSystemKey = (account: string) => Promise<string | undefined>;

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
export const readSystemCredentialKey: ReadSystemKey = async (account) => {
  if (!/^[a-f0-9]{64}$/.test(account)) return;
  const env = {
    ...process.env,
    ZCODE_CREDENTIAL_SECRET: undefined,
    ZCODE_CREDENTIAL_SECRET_FILE: undefined,
  };
  const run = async (file: string, args: string[]) =>
    (await execute(file, args, { env, timeout: 5000, maxBuffer: 4096, windowsHide: true })).stdout;
  try {
    let value: string;
    if (process.platform === "win32") {
      const root = process.env.SystemRoot;
      if (!root || !path.isAbsolute(root)) return;
      const powershell = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      // Encode the public script to preserve quoting through Windows argument parsing.
      const command = `${WIN32_READER}\n[Console]::Write([ZCodeKeyReader]::Read('${account}.${SERVICE}'))`;
      value = await run(powershell, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ]);
    } else if (process.platform === "darwin") {
      const security = "/usr/bin/security";
      const keychain = /^\s*"([^"\r\n]+)"\s*$/.exec(
        await run(security, ["default-keychain", "-d", "user"]),
      )?.[1];
      if (!keychain || !path.isAbsolute(keychain)) return;
      value = await run(security, [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        account,
        "-w",
        keychain,
      ]);
    } else if (process.platform === "linux") {
      value = await run("/usr/bin/secret-tool", [
        "lookup",
        "service",
        SERVICE,
        "username",
        account,
      ]);
    } else return;
    return value.replace(/\r?\n$/, "");
  } catch {
    // Child-process errors can carry stdout, stderr, and command details. Never forward them.
    return undefined;
  }
};
