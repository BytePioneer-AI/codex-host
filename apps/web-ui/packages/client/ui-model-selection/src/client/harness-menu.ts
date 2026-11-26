/** Pure Harness picker grouping & ordering shared by draft switching and bound context handoff. */
import type {
  ModelCatalogFailure,
  ModelCatalogNotInstalled,
  ModelProviderGroup,
} from "@deepseek-ai/dsh-api-session-controller/types";

/** Below this many Harnesses, hide the "Hide unused Agents" CTA (matches Desktop picker). */
export const HARNESS_GROUP_CTA_THRESHOLD = 5;

export type HarnessMenuEntry =
  | {
      readonly kind: "ready";
      readonly id: string;
      readonly name: string;
      readonly hasModels: boolean;
    }
  | {
      readonly kind: "error";
      readonly id: string;
      readonly name: string;
      readonly message: string;
    }
  | {
      readonly kind: "notInstalled";
      readonly id: string;
      readonly name: string;
      readonly installUrl?: string;
    };

export interface HarnessMenuLayout {
  /** Top pinned current Harness row in bound-handoff mode, or undefined in draft/remote modes. */
  readonly boundEntry: HarnessMenuEntry | undefined;
  /** Visible primary list (all main Harnesses in draft mode, or non-bound main Harnesses in handoff mode). */
  readonly main: readonly HarnessMenuEntry[];
  /** Collapsible "More Agents" list (folded Harnesses + uninstalled Harnesses). */
  readonly more: readonly HarnessMenuEntry[];
  /** True in bound-handoff mode when no other Harness is ready, offering same-Harness handoff. */
  readonly showSameHarnessHandoff: boolean;
  /** True when nothing is folded into More yet and the list is long enough to suggest managing groups. */
  readonly showHideUnusedCta: boolean;
}

export interface BuildHarnessMenuLayoutInput {
  readonly harnesses: readonly ModelProviderGroup[];
  readonly failures: readonly ModelCatalogFailure[];
  readonly notInstalled: readonly ModelCatalogNotInstalled[];
  readonly harnessOrder?: readonly string[] | undefined;
  readonly moreHarnesses?: readonly string[] | undefined;
  readonly boundHarnessId: string | null;
  readonly boundHandoffEnabled: boolean;
}

function sortSection(
  entries: readonly HarnessMenuEntry[],
  rank: ReadonlyMap<string, number>,
): HarnessMenuEntry[] {
  return [...entries].sort((left, right) => {
    // Match Desktop: confirmed missing installations trail installed/error rows within a section.
    const installDiff =
      Number(left.kind === "notInstalled") - Number(right.kind === "notInstalled");
    if (installDiff !== 0) return installDiff;
    return (rank.get(left.id) ?? Infinity) - (rank.get(right.id) ?? Infinity);
  });
}

/** Partition ready, errored, and uninstalled Harnesses into Desktop-equivalent Main / More sections. */
export function buildHarnessMenuLayout(input: BuildHarnessMenuLayoutInput): HarnessMenuLayout {
  const rank = new Map((input.harnessOrder ?? []).map((id, index) => [id, index]));
  const moreIds = new Set(input.moreHarnesses ?? []);
  const seen = new Set<string>();
  const all: HarnessMenuEntry[] = [];

  for (const group of input.harnesses) {
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    all.push({
      kind: "ready",
      id: group.id,
      name: group.name,
      hasModels: group.models.length > 0,
    });
  }
  for (const failure of input.failures) {
    if (seen.has(failure.id)) continue;
    seen.add(failure.id);
    all.push({
      kind: "error",
      id: failure.id,
      name: failure.name,
      message: failure.message,
    });
  }
  for (const missing of input.notInstalled) {
    if (seen.has(missing.id)) continue;
    seen.add(missing.id);
    all.push({
      kind: "notInstalled",
      id: missing.id,
      name: missing.name,
      ...(missing.installUrl === undefined ? {} : { installUrl: missing.installUrl }),
    });
  }

  let boundEntry: HarnessMenuEntry | undefined;
  let remaining = all;
  if (input.boundHandoffEnabled && input.boundHarnessId !== null) {
    boundEntry = all.find((entry) => entry.id === input.boundHarnessId);
    remaining = all.filter((entry) => entry.id !== input.boundHarnessId);
  }

  const rawMain: HarnessMenuEntry[] = [];
  const rawMore: HarnessMenuEntry[] = [];
  for (const entry of remaining) {
    const inMore = entry.id !== "codex" && moreIds.has(entry.id);
    (inMore ? rawMore : rawMain).push(entry);
  }

  const main = sortSection(rawMain, rank);
  const more = sortSection(rawMore, rank);
  const hasOtherReady = remaining.some((entry) => entry.kind === "ready" && entry.hasModels);
  const showSameHarnessHandoff =
    input.boundHandoffEnabled &&
    boundEntry !== undefined &&
    boundEntry.kind === "ready" &&
    boundEntry.hasModels &&
    !hasOtherReady;

  return {
    boundEntry,
    main,
    more,
    showSameHarnessHandoff,
    showHideUnusedCta: more.length === 0 && all.length > HARNESS_GROUP_CTA_THRESHOLD,
  };
}
