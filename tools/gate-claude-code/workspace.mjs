import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function claudeProbeLocalRoot(repositoryRoot) {
  return path.resolve(repositoryRoot, ".codexhost", "claude-code-probe");
}

export function assertLocalEvidencePath(repositoryRoot, candidate) {
  const root = claudeProbeLocalRoot(repositoryRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Claude Probe evidence must remain under .codexhost/claude-code-probe`);
}

export function createProbeWorkspace(repositoryRoot, profile, scenario) {
  const root = assertLocalEvidencePath(
    repositoryRoot,
    path.join(
      claudeProbeLocalRoot(repositoryRoot),
      `${process.platform}-${os.arch()}`,
      profile,
      `${Date.now()}-${process.pid}`,
      scenario,
    ),
  );
  const paths = {
    root,
    cwd: path.join(root, "project"),
    raw: path.join(root, "raw"),
    reports: path.join(root, "reports"),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  return paths;
}

export function writeLocalJson(repositoryRoot, outputPath, value) {
  const safePath = assertLocalEvidencePath(repositoryRoot, outputPath);
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(safePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return safePath;
}

export function removeSyntheticProject(workspace) {
  fs.rmSync(workspace.cwd, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 20 : 0,
    retryDelay: 100,
  });
}
