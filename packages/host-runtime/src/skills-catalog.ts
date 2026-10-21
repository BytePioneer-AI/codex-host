import { opendir, readFile } from "node:fs/promises";

import {
  harnessSharedSkillsDirectory,
  scanHarnessSkillsRoot,
  type HarnessSkill,
  type HarnessSkillsCatalogCapability,
} from "@codexhost/harness-adapter";
import {
  harnessSkillsListResultSchema,
  type HarnessSkillEntry,
  type HarnessSkillSetEnabledParams,
  type HarnessSkillsSetEnabledResult,
} from "@codexhost/shared-contracts";
import type { HarnessSkillsSource } from "./skills-source.js";

/** How the skills list reaches the UI, parsed and bounded by the shared-contracts schema. */
export type HarnessSkillsSnapshot = ReturnType<typeof harnessSkillsListResultSchema.parse>;

/**
 * Machine-wide skills catalog from the adapters that expose their local skill storage, plus the
 * Host's cross-Harness shared directory. Read-only: never starts a process, opens a Session, or
 * writes native storage. A failed source is reported as a group failure instead of being hidden.
 */
export class HarnessSkillsCatalog {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: { environment?: NodeJS.ProcessEnv }) {
    this.#environment = options.environment ?? process.env;
  }

  /** Reads every source fresh; the catalog is small and the page expects current disk state. */
  async list(sources: readonly HarnessSkillsSource[]): Promise<HarnessSkillsSnapshot> {
    const groups = await Promise.all([
      ...sources.map(({ harness, label, capability }) =>
        this.#readHarness(harness, label ?? capability.label, capability),
      ),
      this.#readShared(),
    ]);
    return harnessSkillsListResultSchema.parse({
      groups: groups.sort((a, b) => a.harness.localeCompare(b.harness)),
    });
  }

  /**
   * Flips one skill through the Harness's own switch. A Harness without `setEnabled` — or an
   * unknown Harness name — refuses instead of pretending, so the page can show why.
   */
  async setEnabled(
    sources: readonly HarnessSkillsSource[],
    params: HarnessSkillSetEnabledParams,
  ): Promise<HarnessSkillsSetEnabledResult> {
    const source = sources.find((entry) => entry.harness === params.harness);
    if (!source) return { ok: false, reason: `No Harness named ${params.harness}` };
    const toggle = source.capability.setEnabled;
    if (typeof toggle !== "function") {
      return { ok: false, reason: `${params.harness} does not expose a skill switch` };
    }
    return toggle.call(source.capability, params.name, params.enabled, AbortSignal.timeout(60_000));
  }

  async #readHarness(
    harness: string,
    label: string | undefined,
    capability: HarnessSkillsCatalogCapability,
  ): Promise<HarnessSkillGroupDraft> {
    const heading = {
      harness,
      ...(label ? { sourceLabel: label } : {}),
      origin: "harness" as const,
    };
    try {
      const read = await capability.list(AbortSignal.timeout(30_000));
      return {
        ...heading,
        skills: read.skills.map(toEntry),
        failures: (read.failures ?? []).map((failure) => ({
          path: failure.path,
          message: failure.message,
        })),
      };
    } catch (error) {
      return {
        ...heading,
        skills: [],
        failures: [{ path: harness, message: boundedMessage(error) }],
      };
    }
  }

  async #readShared(): Promise<HarnessSkillGroupDraft> {
    const heading = { harness: "shared", origin: "shared" as const };
    const directory = harnessSharedSkillsDirectory(this.#environment);
    if (!directory) return { ...heading, skills: [], failures: [] };
    try {
      const scan = await scanHarnessSkillsRoot(
        directory,
        { readdir: readDirectories, readFile: (file) => readFile(file, "utf8") },
        AbortSignal.timeout(30_000),
      );
      return {
        ...heading,
        skills: scan.skills.map(toEntry),
        failures: scan.failures,
      };
    } catch (error) {
      return {
        ...heading,
        skills: [],
        failures: [{ path: directory, message: boundedMessage(error) }],
      };
    }
  }
}

/** One harness's skill capability, duck-typed off the adapter by the Host. */
export type { HarnessSkillsSource } from "./skills-source.js";

interface HarnessSkillGroupDraft {
  harness: string;
  sourceLabel?: string;
  origin: "harness" | "shared";
  skills: HarnessSkillEntry[];
  failures: { path: string; message: string }[];
}

function toEntry(skill: HarnessSkill): HarnessSkillEntry {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.category ? { category: skill.category } : {}),
    path: skill.path,
    enabled: skill.enabled ?? true,
    archived: skill.archived ?? false,
    ...(skill.toggle ? { toggle: skill.toggle } : {}),
  };
}

function boundedMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 0 && text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

/** Directories only; files and unreadable entries are skipped by the scanner's contract. */
export async function readDirectories(directory: string): Promise<readonly string[]> {
  const entries: string[] = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      if (entry.isDirectory()) entries.push(entry.name);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return entries.sort((a, b) => a.localeCompare(b));
}
