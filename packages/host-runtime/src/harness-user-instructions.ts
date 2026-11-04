import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  harnessPluginIdSchema,
  harnessUserInstructionsDisabledListSchema,
  harnessUserInstructionsSetSchema,
  type HarnessId,
  type HarnessUserInstructionsSet,
  type HarnessUserInstructionsSettings,
} from "@codexhost/shared-contracts";
import { z } from "zod";

interface ExternalUserInstructionsTarget {
  readonly harnessId: HarnessId;
  readonly displayPath: string;
  readonly rootDir: string;
  readonly filePath: string;
}

const storedSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  disabledHarnesses: harnessUserInstructionsDisabledListSchema.default([]),
});

const backupManifestSchema = z.strictObject({
  hadOriginal: z.boolean(),
  originalContent: z.string().optional(),
  syncedDigest: z.string().min(1),
});

type StoredUserInstructionsSettings = z.infer<typeof storedSettingsSchema>;
type BackupManifest = z.infer<typeof backupManifestSchema>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveHome(environment: NodeJS.ProcessEnv): string {
  const candidate =
    (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) ||
    environment.HOME ||
    environment.USERPROFILE;
  return candidate ? path.resolve(candidate) : os.homedir();
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
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

export function resolveExternalUserInstructionsTargets(
  environment: NodeJS.ProcessEnv,
): readonly ExternalUserInstructionsTarget[] {
  const home = resolveHome(environment);
  const claudeRoot = environment.CLAUDE_CONFIG_DIR
    ? path.resolve(environment.CLAUDE_CONFIG_DIR)
    : path.join(home, ".claude");
  const grokRoot = environment.GROK_HOME
    ? path.resolve(environment.GROK_HOME)
    : path.join(home, ".grok");
  const kimiRoot = environment.KIMI_CODE_HOME
    ? path.resolve(environment.KIMI_CODE_HOME)
    : path.join(home, ".kimi-code");
  const kiroRoot = environment.KIRO_HOME
    ? path.resolve(environment.KIRO_HOME)
    : path.join(home, ".kiro");
  const ompAgentDir = environment.OMP_CODING_AGENT_DIR
    ? path.resolve(environment.OMP_CODING_AGENT_DIR)
    : path.join(home, ".omp", "agent");
  const ompRoot = environment.OMP_CODING_AGENT_DIR ? ompAgentDir : path.join(home, ".omp");
  const opencodeRoot = path.join(
    environment.XDG_CONFIG_HOME
      ? path.resolve(environment.XDG_CONFIG_HOME)
      : path.join(home, ".config"),
    "opencode",
  );
  const piAgentDir = environment.PI_CODING_AGENT_DIR
    ? path.resolve(environment.PI_CODING_AGENT_DIR)
    : path.join(home, ".pi", "agent");
  const piRoot = environment.PI_CODING_AGENT_DIR ? piAgentDir : path.join(home, ".pi");
  const qoderRoot = environment.QODER_CONFIG_DIR
    ? path.resolve(environment.QODER_CONFIG_DIR)
    : path.join(home, ".qoder");
  const qoderCnRoot = environment.QODER_CN_CONFIG_DIR
    ? path.resolve(environment.QODER_CN_CONFIG_DIR)
    : path.join(home, ".qoder-cn");
  const qwenRoot = environment.QWEN_CONFIG_DIR
    ? path.resolve(environment.QWEN_CONFIG_DIR)
    : path.join(home, ".qwen");
  const zcodeRoot = path.join(
    environment.ZCODE_DATA_BASE_DIR?.trim()
      ? path.resolve(environment.ZCODE_DATA_BASE_DIR.trim())
      : home,
    ".zcode",
  );

  const entries: Array<{
    id: string;
    displayPath: string;
    rootDir: string;
    filePath: string;
  }> = [
    {
      id: "antigravity",
      displayPath: "~/.gemini/GEMINI.md",
      rootDir: path.join(home, ".gemini"),
      filePath: path.join(home, ".gemini", "GEMINI.md"),
    },
    {
      id: "claude-code",
      displayPath: "~/.claude/CLAUDE.md",
      rootDir: claudeRoot,
      filePath: path.join(claudeRoot, "CLAUDE.md"),
    },
    {
      id: "codebuddy",
      displayPath: "~/.codebuddy/CODEBUDDY.md",
      rootDir: path.join(home, ".codebuddy"),
      filePath: path.join(home, ".codebuddy", "CODEBUDDY.md"),
    },
    {
      id: "copilot",
      displayPath: "~/.copilot/copilot-instructions.md",
      rootDir: path.join(home, ".copilot"),
      filePath: path.join(home, ".copilot", "copilot-instructions.md"),
    },
    {
      id: "cursor-cli",
      displayPath: "~/.cursor/AGENTS.md",
      rootDir: path.join(home, ".cursor"),
      filePath: path.join(home, ".cursor", "AGENTS.md"),
    },
    {
      id: "deepseek-harness",
      displayPath: "~/.deepseek/AGENTS.md",
      rootDir: path.join(home, ".deepseek"),
      filePath: path.join(home, ".deepseek", "AGENTS.md"),
    },
    {
      id: "devin",
      displayPath: "~/.devin/AGENTS.md",
      rootDir: path.join(home, ".devin"),
      filePath: path.join(home, ".devin", "AGENTS.md"),
    },
    {
      id: "grok",
      displayPath: "~/.grok/AGENTS.md",
      rootDir: grokRoot,
      filePath: path.join(grokRoot, "AGENTS.md"),
    },
    {
      id: "hermes",
      displayPath: "~/.hermes/AGENTS.md",
      rootDir: path.join(home, ".hermes"),
      filePath: path.join(home, ".hermes", "AGENTS.md"),
    },
    {
      id: "kimi-code",
      displayPath: "~/.kimi-code/AGENTS.md",
      rootDir: kimiRoot,
      filePath: path.join(kimiRoot, "AGENTS.md"),
    },
    {
      id: "kiro-cli",
      displayPath: "~/.kiro/steering/AGENTS.md",
      rootDir: kiroRoot,
      filePath: path.join(kiroRoot, "steering", "AGENTS.md"),
    },
    {
      id: "omp",
      displayPath: "~/.omp/agent/AGENTS.md",
      rootDir: ompRoot,
      filePath: path.join(ompAgentDir, "AGENTS.md"),
    },
    {
      id: "opencode",
      displayPath: "~/.config/opencode/AGENTS.md",
      rootDir: opencodeRoot,
      filePath: path.join(opencodeRoot, "AGENTS.md"),
    },
    {
      id: "pi",
      displayPath: "~/.pi/agent/AGENTS.md",
      rootDir: piRoot,
      filePath: path.join(piAgentDir, "AGENTS.md"),
    },
    {
      id: "qoder",
      displayPath: "~/.qoder/AGENTS.md",
      rootDir: qoderRoot,
      filePath: path.join(qoderRoot, "AGENTS.md"),
    },
    {
      id: "qoder-cn",
      displayPath: "~/.qoder-cn/AGENTS.md",
      rootDir: qoderCnRoot,
      filePath: path.join(qoderCnRoot, "AGENTS.md"),
    },
    {
      id: "qwen-code",
      displayPath: "~/.qwen/QWEN.md",
      rootDir: qwenRoot,
      filePath: path.join(qwenRoot, "QWEN.md"),
    },
    {
      id: "workbuddy",
      displayPath: "~/.workbuddy-ai/WORKBUDDY.md",
      rootDir: path.join(home, ".workbuddy-ai"),
      filePath: path.join(home, ".workbuddy-ai", "WORKBUDDY.md"),
    },
    {
      id: "zcode",
      displayPath: "~/.zcode/AGENTS.md",
      rootDir: zcodeRoot,
      filePath: path.join(zcodeRoot, "AGENTS.md"),
    },
  ];

  return entries.map((entry) => ({
    harnessId: harnessPluginIdSchema.parse(entry.id),
    displayPath: entry.displayPath,
    rootDir: entry.rootDir,
    filePath: entry.filePath,
  }));
}

async function readCodexUserInstructions(
  environment: NodeJS.ProcessEnv,
): Promise<{ displayPath: string; content: string | null }> {
  const home = resolveHome(environment);
  const codexHome = environment.CODEX_HOME
    ? path.resolve(environment.CODEX_HOME)
    : path.join(home, ".codex");
  const overridePath = path.join(codexHome, "AGENTS.override.md");
  const overrideContent = await readOptionalFile(overridePath);
  if (overrideContent !== null && overrideContent.trim().length > 0) {
    return {
      displayPath: "~/.codex/AGENTS.override.md",
      content: overrideContent,
    };
  }
  const defaultPath = path.join(codexHome, "AGENTS.md");
  const defaultContent = await readOptionalFile(defaultPath);
  return {
    displayPath: "~/.codex/AGENTS.md",
    content: defaultContent !== null && defaultContent.trim().length > 0 ? defaultContent : null,
  };
}

/**
 * Manages optional replacement of non-Codex CLI global user instruction files
 * with Codex's user custom instructions (`$CODEX_HOME/AGENTS.override.md` or
 * `$CODEX_HOME/AGENTS.md`), backing up each CLI's original file before replacement
 * and restoring it when disabled.
 */
export class HarnessUserInstructionsStore {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #settingsFile: string;
  readonly #backupsDir: string;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment;
    const dataDir = environment.CODEXHOST_DATA_DIR
      ? path.resolve(environment.CODEXHOST_DATA_DIR)
      : path.join(resolveHome(environment), ".codexhost");
    this.#settingsFile = path.join(dataDir, "harness-user-instructions-settings-v1.json");
    this.#backupsDir = path.join(dataDir, "user-instructions-backups");
  }

  async #readStored(): Promise<StoredUserInstructionsSettings> {
    try {
      const raw = await readFile(this.#settingsFile, "utf8");
      return storedSettingsSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { enabled: false, disabledHarnesses: [] };
      }
      throw new Error("Could not read Harness user instructions settings");
    }
  }

  #backupPath(harnessId: HarnessId): string {
    return path.join(this.#backupsDir, `${harnessId}.json`);
  }

  async #readBackup(harnessId: HarnessId): Promise<BackupManifest | null> {
    const raw = await readOptionalFile(this.#backupPath(harnessId));
    if (raw === null) return null;
    try {
      return backupManifestSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async #writeBackup(harnessId: HarnessId, manifest: BackupManifest): Promise<void> {
    await atomicWriteFile(this.#backupPath(harnessId), `${JSON.stringify(manifest)}\n`);
  }

  async #removeBackup(harnessId: HarnessId): Promise<void> {
    await rm(this.#backupPath(harnessId), { force: true });
  }

  async get(): Promise<HarnessUserInstructionsSettings> {
    const stored = await this.#readStored();
    const disabled = new Set(stored.disabledHarnesses);
    const source = await readCodexUserInstructions(this.#environment);
    const targets = resolveExternalUserInstructionsTargets(this.#environment);
    return {
      enabled: stored.enabled,
      sourcePath: source.displayPath,
      harnesses: targets.map((target) => ({
        harnessId: target.harnessId,
        enabled: !disabled.has(target.harnessId),
        targetPath: target.displayPath,
      })),
    };
  }

  async set(input: HarnessUserInstructionsSet): Promise<HarnessUserInstructionsSettings> {
    const parsed = harnessUserInstructionsSetSchema.parse(input);
    const previous = await this.#readStored().catch(() => ({
      enabled: false,
      disabledHarnesses: [] as HarnessId[],
    }));
    const targets = resolveExternalUserInstructionsTargets(this.#environment);
    const validIds = new Set(targets.map((target) => target.harnessId));
    const disabledHarnesses = (parsed.disabledHarnesses ?? previous.disabledHarnesses).filter(
      (id) => validIds.has(id),
    );
    const next: StoredUserInstructionsSettings = {
      enabled: parsed.enabled,
      disabledHarnesses,
    };
    await atomicWriteFile(this.#settingsFile, `${JSON.stringify(next)}\n`);
    await this.sync();
    return await this.get();
  }

  /**
   * Synchronizes all external CLI instruction files whose config root directory
   * exists on disk (or that have a managed backup manifest to update/restore).
   */
  async sync(): Promise<void> {
    const stored = await this.#readStored();
    const disabled = new Set(stored.disabledHarnesses);
    const source = await readCodexUserInstructions(this.#environment);
    const targets = resolveExternalUserInstructionsTargets(this.#environment);
    for (const target of targets) {
      const active = stored.enabled && !disabled.has(target.harnessId);
      await this.#syncTarget(target, active, source.content, false);
    }
  }

  /**
   * Synchronizes one external CLI's global user instruction file right before a
   * session is opened or resumed, creating its config directory if enabled.
   */
  async syncHarness(harnessId: string): Promise<void> {
    const targets = resolveExternalUserInstructionsTargets(this.#environment);
    const target = targets.find((candidate) => candidate.harnessId === harnessId);
    if (!target) return;
    const stored = await this.#readStored();
    const disabled = new Set(stored.disabledHarnesses);
    const active = stored.enabled && !disabled.has(target.harnessId);
    const source = await readCodexUserInstructions(this.#environment);
    await this.#syncTarget(target, active, source.content, true);
  }

  async #syncTarget(
    target: ExternalUserInstructionsTarget,
    active: boolean,
    codexContent: string | null,
    createMissingRoot: boolean,
  ): Promise<void> {
    const existingBackup = await this.#readBackup(target.harnessId);
    if (active && codexContent !== null) {
      if (!createMissingRoot && !existingBackup && !(await directoryExists(target.rootDir))) {
        return;
      }
      const currentContent = await readOptionalFile(target.filePath);
      const nextDigest = digest(codexContent);
      if (!existingBackup) {
        await this.#writeBackup(
          target.harnessId,
          currentContent === null
            ? { hadOriginal: false, syncedDigest: nextDigest }
            : { hadOriginal: true, originalContent: currentContent, syncedDigest: nextDigest },
        );
      } else if (
        currentContent !== null &&
        currentContent !== codexContent &&
        digest(currentContent) !== existingBackup.syncedDigest
      ) {
        // Preserve manual edits made to the native file while sync was active.
        await this.#writeBackup(target.harnessId, {
          hadOriginal: true,
          originalContent: currentContent,
          syncedDigest: nextDigest,
        });
      } else if (existingBackup.syncedDigest !== nextDigest) {
        await this.#writeBackup(target.harnessId, {
          ...existingBackup,
          syncedDigest: nextDigest,
        });
      }
      if (currentContent !== codexContent) {
        await atomicWriteFile(target.filePath, codexContent);
      }
      return;
    }

    if (!existingBackup) return;
    const currentContent = await readOptionalFile(target.filePath);
    const unmodifiedSinceSync =
      currentContent === null || digest(currentContent) === existingBackup.syncedDigest;
    if (unmodifiedSinceSync) {
      if (existingBackup.hadOriginal && existingBackup.originalContent !== undefined) {
        await atomicWriteFile(target.filePath, existingBackup.originalContent);
      } else if (!existingBackup.hadOriginal && currentContent !== null) {
        await rm(target.filePath, { force: true });
      }
    }
    await this.#removeBackup(target.harnessId);
  }
}
