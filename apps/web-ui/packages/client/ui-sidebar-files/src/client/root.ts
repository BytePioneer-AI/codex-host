import { resolveWorkspacePath } from "@deepseek-ai/dsh-util-workspace-path";

export function filesRoot(
  cwd: string | undefined,
  directory: string | undefined,
  remoteFilesReady: boolean,
): string | undefined {
  if (directory === ".") return cwd ?? directory;
  return directory === undefined
    ? (cwd ?? (remoteFilesReady ? "." : undefined))
    : resolveWorkspacePath(cwd, directory);
}
