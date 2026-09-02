import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TAIL_BYTES = 64 * 1024;

export function findOmpDaemonLogPath(cwd: string, processId: string): string | null {
  if (!processId || processId.trim().length === 0) return null;
  const targetId = processId.trim();
  const home = os.homedir();
  const daemonsRoot = path.join(home, ".omp", "run", "daemons");
  if (!fs.existsSync(daemonsRoot)) return null;

  try {
    const entries = fs.readdirSync(daemonsRoot, { withFileTypes: true });
    const targetCwd = path.resolve(cwd);

    // 1. First search for matching scope.json projectDir
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidateDir = path.join(daemonsRoot, entry.name);
      const logPath = path.join(candidateDir, "daemons", targetId, "output.log");
      if (fs.existsSync(logPath)) {
        const scopePath = path.join(candidateDir, "scope.json");
        if (fs.existsSync(scopePath)) {
          try {
            const scope = JSON.parse(fs.readFileSync(scopePath, "utf8")) as { projectDir?: string };
            if (scope.projectDir && path.resolve(scope.projectDir) === targetCwd) {
              return logPath;
            }
          } catch {
            // Ignore malformed scope file
          }
        }
      }
    }

    // 2. Fallback: match any existing log file across daemon scopes
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const logPath = path.join(daemonsRoot, entry.name, "daemons", targetId, "output.log");
      if (fs.existsSync(logPath)) return logPath;
    }
  } catch {
    // Non-fatal filesystem read error
  }
  return null;
}

export function readOmpDaemonTail(
  cwd: string,
  processId: string,
  limitBytes = DEFAULT_TAIL_BYTES,
): string | null {
  const logPath = findOmpDaemonLogPath(cwd, processId);
  if (!logPath) return null;
  try {
    const stat = fs.statSync(logPath);
    if (stat.size === 0) return null;
    const startOffset = Math.max(0, stat.size - limitBytes);
    const length = stat.size - startOffset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, startOffset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function readOmpDaemonSlice(
  logPath: string,
  offset: number,
): { text: string; nextOffset: number } {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= offset) {
      return { text: "", nextOffset: stat.size };
    }
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8");
    return { text, nextOffset: stat.size };
  } catch {
    return { text: "", nextOffset: offset };
  }
}
