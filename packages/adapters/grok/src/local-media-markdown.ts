import os from "node:os";
import path from "node:path";

export function grokMediaResolveRoots(cwd: string, sessionDirectory?: string): string[] {
  const roots = [path.resolve(cwd)];
  if (sessionDirectory) {
    const session = path.resolve(sessionDirectory);
    roots.push(session, path.join(session, "videos"), path.join(session, "images"));
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  if (home) roots.push(path.join(home, "Downloads"));
  return roots;
}
