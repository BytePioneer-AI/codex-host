import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  harnessSharedSkillsDirectory,
  scanHarnessSkillsRoot,
  type HarnessSkill,
  type HarnessSkillsCatalogCapability,
  readDirectories,
  HARNESS_SKILL_MANIFEST,
} from "@codexhost/harness-adapter";
import {
  harnessSkillsListResultSchema,
  type HarnessSkillContentParams,
  type HarnessSkillEntry,
  type HarnessSkillSetEnabledParams,
  type HarnessSkillsContentResult,
  type HarnessSkillsSetEnabledResult,
  type HarnessSkillUninstallParams,
  type HarnessSkillsUninstallResult,
} from "@codexhost/shared-contracts";
import type { HarnessSkillsSource } from "./skills-source.js";

/** How the skills list reaches the UI, parsed and bounded by the shared-contracts schema. */
export type HarnessSkillsSnapshot = ReturnType<typeof harnessSkillsListResultSchema.parse>;

/** Shared-group manifest read ceiling, mirroring the adapter-side detail dialog bound. */
const MAX_SHARED_CONTENT = 256 * 1024;

/**
 * Machine-wide skills catalog from the adapters that expose their local skill storage, plus the
 * Host's cross-Harness shared directory. The list is read-only; the switches and removals route
 * through the adapter's own capability (which may run the Harness's config writer or move
 * archive directories), each re-confirmed against a fresh scan. The shared group serves content
 * reads but never edits. A failed source is reported as a group failure instead of being hidden.
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
    return toggle.call(
      source.capability,
      { name: params.name, ...(params.path === undefined ? {} : { path: params.path }) },
      params.enabled,
      AbortSignal.timeout(60_000),
    );
  }

  /** One skill's SKILL.md, straight from its own directory; bounded and root-checked. */
  async readContent(
    sources: readonly HarnessSkillsSource[],
    params: HarnessSkillContentParams,
  ): Promise<HarnessSkillsContentResult> {
    // The shared group has no adapter behind it, but read-only must not mean unreadable: serve
    // its manifests straight from the shared root the list already scanned.
    if (params.harness === "shared") return this.#readSharedContent(params);
    const source = sources.find((entry) => entry.harness === params.harness);
    if (!source) {
      return {
        ok: false,
        content: "",
        truncated: false,
        reason: `No Harness named ${params.harness}`,
      };
    }
    const read = source.capability.readContent;
    if (typeof read !== "function") {
      return {
        ok: false,
        content: "",
        truncated: false,
        reason: `${params.harness} does not expose skill content`,
      };
    }
    const result = await read.call(
      source.capability,
      { name: params.name, ...(params.path === undefined ? {} : { path: params.path }) },
      AbortSignal.timeout(30_000),
    );
    return {
      ok: result.ok,
      content: result.content ?? "",
      truncated: result.truncated ?? false,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }

  /** Deletes one skill directory through the Harness's own capability. Destructive. */
  async uninstall(
    sources: readonly HarnessSkillsSource[],
    params: HarnessSkillUninstallParams,
  ): Promise<HarnessSkillsUninstallResult> {
    const source = sources.find((entry) => entry.harness === params.harness);
    if (!source) return { ok: false, reason: `No Harness named ${params.harness}` };
    const remove = source.capability.uninstall;
    if (typeof remove !== "function") {
      return { ok: false, reason: `${params.harness} does not allow removing skills` };
    }
    const result = await remove.call(
      source.capability,
      { name: params.name, ...(params.path === undefined ? {} : { path: params.path }) },
      AbortSignal.timeout(30_000),
    );
    return {
      ok: result.ok,
      ...(result.path === undefined ? {} : { path: result.path }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
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

  /** Manifest read for the shared group: the page may open details, never edits. */
  async #readSharedContent(params: HarnessSkillContentParams): Promise<HarnessSkillsContentResult> {
    const fail = (reason: string): HarnessSkillsContentResult => ({
      ok: false,
      content: "",
      truncated: false,
      reason,
    });
    try {
      const directory = harnessSharedSkillsDirectory(this.#environment);
      if (!directory) return fail("The shared skills directory is unavailable");
      const scan = await scanHarnessSkillsRoot(
        directory,
        { readdir: readDirectories, readFile: (file) => readFile(file, "utf8") },
        AbortSignal.timeout(30_000),
      );
      const byName = scan.skills.filter((entry) => entry.name === params.name);
      const skill =
        params.path === undefined
          ? byName.length === 1
            ? byName[0]
            : undefined
          : byName.find((entry) => entry.path === params.path);
      if (!skill) return fail(`No shared skill named ${params.name} at ${params.path ?? "?"}`);
      const text = await readFile(path.join(skill.path, HARNESS_SKILL_MANIFEST), "utf8");
      return {
        ok: true,
        content: text.length > MAX_SHARED_CONTENT ? text.slice(0, MAX_SHARED_CONTENT) : text,
        truncated: text.length > MAX_SHARED_CONTENT,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
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
