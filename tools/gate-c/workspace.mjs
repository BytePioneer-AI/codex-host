import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GateCError } from "./errors.mjs";

export function gateCLocalRoot(repositoryRoot) {
  return path.resolve(repositoryRoot, ".codexhost", "gate-c");
}

export function assertLocalEvidencePath(repositoryRoot, candidate) {
  const root = gateCLocalRoot(repositoryRoot);
  const relative = path.relative(root, path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.resolve(candidate);
  }
  throw new GateCError(
    "EVIDENCE_PATH",
    `Real Gate C evidence must remain under ${path.relative(repositoryRoot, root)}`,
  );
}

export function createGateWorkspace(repositoryRoot, profile, { runId } = {}) {
  const id = runId ?? `${Date.now()}-${process.pid}`;
  const root = assertLocalEvidencePath(
    repositoryRoot,
    path.join(gateCLocalRoot(repositoryRoot), `${process.platform}-${os.arch()}`, profile, id),
  );
  const paths = {
    root,
    cwd: path.join(root, "project"),
    sessions: path.join(root, "sessions"),
    raw: path.join(root, "raw"),
    reports: path.join(root, "reports"),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  return paths;
}

export function removeNonEvidenceWorkspace(paths) {
  fs.rmSync(paths.cwd, { recursive: true, force: true });
}
