import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RULE_VERSION = 3;
const RULE_FILE = "codexhost-desktop.md";
const PREVIOUS_MANAGED_DIGESTS: readonly string[] = [
  "5add2d2c7ea03ecbb3552b94e47da7a755909e63f30714878a5609a4e272526f",
  "9d8d2762b5f90e6f10a6571651b3461dec882bd45b40f0f0debc432f4833301b",
];

export const CODEXHOST_DESKTOP_RULE = `<!-- codexhost-desktop-rule: ${RULE_VERSION} -->
# Codex Desktop / CodexHost

CodexHost installs this file into Grok home rules. Orca and Grok TUI sessions may also load it.

At the first user turn, if you have a shell, run this once and print only \`set\` or \`unset\`:

\`\`\`sh
if test -n "\${CODEXHOST_THREAD_ID-}"; then echo set; else echo unset; fi
\`\`\`

- \`set\`: this is a CodexHost external Thread, including Codex Desktop. Apply the session rules even when cwd is a real repository such as \`codex-host\` or the wiki.
- Working directory is a Playground folder named \`realtime-voice-chat\` or \`realtime-voice-chat-*\`: apply the session rules and ask the user to start a new Thread in the real repo.
- \`unset\` and not a Playground voice cwd: leave the session rules inactive.

Never print \`CODEXHOST_THREAD_ID\`, \`CODEXHOST_RUNTIME_TOKEN\`, \`CODEXHOST_RUNTIME_ENDPOINT\`, or other runtime descriptors. Do not invent other host signals.

## Session rules

1. **Model.** The Desktop composer Model is this Harness's Model. Pick that Harness's real Model before starting voice. For Grok, that is grok-4.6 or grok-4.7. \`flash-max\` is a Gemini Flash Model.

2. **Working directory.** Start the chat in the real repository (\`codex-host\` or the wiki). A Playground \`realtime-voice-chat*\` folder is a scratch cwd. Ask the user to start a new Thread in the real repo.

3. **Voice vs tools.** Desktop voice is gpt-live speech plus delegated Harness tasks on this same Thread. Do wiki, MCP, and file-heavy work as text in this Thread.

4. **Harness-owned tools.** This session's MCP servers and skills belong to this Harness. SkillWiki on Grok is Grok's config, not Claude, Pi, or Codex.

5. **Desktop chrome.** The window is Codex Desktop. Markdown View preview is a Codex file tab (View preview vs View source). \`file://\` browser tabs stay raw.

6. **Voice routes.** Official Codex live voice (New API/CPA) is a separate route from Host-owned external \`thread/realtime/*\`. This external Thread uses the Host-owned route.

Keep Grok Build tools, MCP, and rules inside the native session. An \`AGENT_TOOLS_AND_RULES.md\` dump in the cwd is unnecessary.
`;

const CURRENT_DIGEST = createHash("sha256").update(CODEXHOST_DESKTOP_RULE).digest("hex");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedVersion(value: string): number | null {
  const match = /codexhost-desktop-rule:\s*(\d+)/u.exec(value);
  return match ? Number(match[1]) : null;
}

function grokDestination(home: string): string {
  return path.join(home, ".grok", "rules", RULE_FILE);
}

function claudeDestination(home: string): string {
  return path.join(home, ".claude", "rules", RULE_FILE);
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath), `.${RULE_FILE}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export type DesktopRuleInstallStatus = "installed" | "updated" | "current" | "conflict" | "removed";

export interface DesktopRuleInstallResult {
  path: string;
  status: DesktopRuleInstallStatus;
  version: number | null;
  digest: string | null;
}

export async function installCodexhostDesktopRules(
  input: {
    homeDirectory?: string;
    previousManagedDigests?: readonly string[];
  } = {},
): Promise<DesktopRuleInstallResult[]> {
  const home = input.homeDirectory ?? os.homedir();
  const knownDigests = new Set([
    CURRENT_DIGEST,
    ...PREVIOUS_MANAGED_DIGESTS,
    ...(input.previousManagedDigests ?? []),
  ]);
  const results: DesktopRuleInstallResult[] = [];
  const destination = grokDestination(home);
  const current = await readOptional(destination);
  if (current === CODEXHOST_DESKTOP_RULE) {
    results.push({
      path: destination,
      status: "current",
      version: RULE_VERSION,
      digest: CURRENT_DIGEST,
    });
  } else if (current !== null) {
    const currentDigest = digest(current);
    const version = managedVersion(current);
    if (!knownDigests.has(currentDigest)) {
      results.push({ path: destination, status: "conflict", version, digest: currentDigest });
    } else {
      await atomicWrite(destination, CODEXHOST_DESKTOP_RULE);
      results.push({
        path: destination,
        status: "updated",
        version: RULE_VERSION,
        digest: CURRENT_DIGEST,
      });
    }
  } else {
    await atomicWrite(destination, CODEXHOST_DESKTOP_RULE);
    results.push({
      path: destination,
      status: "installed",
      version: RULE_VERSION,
      digest: CURRENT_DIGEST,
    });
  }
  const claude = claudeDestination(home);
  const claudeCurrent = await readOptional(claude);
  if (claudeCurrent !== null) {
    const claudeDigest = digest(claudeCurrent);
    const version = managedVersion(claudeCurrent);
    if (knownDigests.has(claudeDigest) || claudeCurrent === CODEXHOST_DESKTOP_RULE) {
      await rm(claude, { force: true });
      results.push({ path: claude, status: "removed", version, digest: claudeDigest });
    } else {
      results.push({ path: claude, status: "conflict", version, digest: claudeDigest });
    }
  }
  for (const result of results) {
    if (result.status === "conflict" || result.status === "removed") continue;
    const source = await readFile(result.path, "utf8");
    const metadata = await stat(result.path);
    if (!metadata.isFile() || source !== CODEXHOST_DESKTOP_RULE) {
      throw new Error(`Codex Desktop rule verification failed: ${result.path}`);
    }
  }
  return results;
}
