import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RULE_FILE = "codexhost-desktop.md";

/** Host-owned home-rule copies written before ACP `_meta.rules` replaced them. */
const MANAGED_DIGESTS: readonly string[] = [
  "5add2d2c7ea03ecbb3552b94e47da7a755909e63f30714878a5609a4e272526f",
  "9d8d2762b5f90e6f10a6571651b3461dec882bd45b40f0f0debc432f4833301b",
  "4658e68f312686e2134cd282abd9ce434d2583b0a1d23c7c3eb8bd7ec9b76cf3",
];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function destinations(home: string): string[] {
  return [
    path.join(home, ".grok", "rules", RULE_FILE),
    path.join(home, ".claude", "rules", RULE_FILE),
  ];
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type DesktopRuleRetireStatus = "removed" | "absent" | "conflict";

export interface DesktopRuleRetireResult {
  path: string;
  status: DesktopRuleRetireStatus;
  digest: string | null;
}

/** Remove Host-owned copies. User-edited files stay in place. Does not install a replacement. */
export async function retireCodexhostDesktopRules(
  input: {
    homeDirectory?: string;
    previousManagedDigests?: readonly string[];
  } = {},
): Promise<DesktopRuleRetireResult[]> {
  const home = input.homeDirectory ?? os.homedir();
  const knownDigests = new Set([...MANAGED_DIGESTS, ...(input.previousManagedDigests ?? [])]);
  const results: DesktopRuleRetireResult[] = [];
  for (const destination of destinations(home)) {
    const current = await readOptional(destination);
    if (current === null) {
      results.push({ path: destination, status: "absent", digest: null });
      continue;
    }
    const currentDigest = digest(current);
    if (!knownDigests.has(currentDigest)) {
      results.push({ path: destination, status: "conflict", digest: currentDigest });
      continue;
    }
    await rm(destination, { force: true });
    results.push({ path: destination, status: "removed", digest: currentDigest });
  }
  return results;
}
