import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface ProjectlessWorkspace {
  cwd: string;
  workspaceRoot: string;
  outputDirectory: string;
}

/** The execution owner allocates a fresh directory, never an existing project.
 * Match Codex's date/ASCII-prompt-slug layout, exclusive collision handling and
 * root/outputs/work split. These are execution paths, not a project registry. */
export async function allocateProjectlessWorkspace(
  environment: NodeJS.ProcessEnv,
  prompt: string,
  options: { now?: Date; root?: string } = {},
): Promise<ProjectlessWorkspace> {
  const home = environment[process.platform === "win32" ? "USERPROFILE" : "HOME"] ?? homedir();
  const workspaceRoot = options.root ?? path.join(home, "Documents", "Codex");
  if (!path.isAbsolute(workspaceRoot))
    throw new Error("Projectless workspace root must be absolute");
  const realDirectory = async (directory: string) => {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Projectless workspace must be a real directory");
  };
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await realDirectory(workspaceRoot);
  const date = options.now ?? new Date();
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const parent = path.join(workspaceRoot, day);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await realDirectory(parent);
  const slug = (
    prompt
      .toLowerCase()
      .match(/[a-z0-9]+/gu)
      ?.slice(0, 6)
      .join("-") ?? "new-chat"
  ).slice(0, 80);
  for (let index = 0; index < 105; index++) {
    const name =
      index === 0 ? slug : index < 100 ? `${slug}-${index + 1}` : `${slug}-${randomUUID()}`;
    const cwd = path.join(parent, name);
    try {
      await mkdir(cwd, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // Never delete an allocated directory after an uncertain Thread creation.
    // The paths may already be referenced by a Native Session.
    const outputDirectory = path.join(cwd, "outputs");
    try {
      await mkdir(outputDirectory, { mode: 0o700 });
      await mkdir(path.join(cwd, "work"), { mode: 0o700 });
      return { cwd, workspaceRoot, outputDirectory };
    } catch {
      return { cwd, workspaceRoot, outputDirectory: cwd };
    }
  }
  throw new Error("Unable to allocate a unique projectless workspace");
}
