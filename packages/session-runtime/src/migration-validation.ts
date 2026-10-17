import { isAbsolute } from "node:path";
import { canonicalSessionPath } from "./ownership-lock.js";
import {
  emptyLocalOrganization,
  type LocalOrganizationState,
  type LocalWorkspace,
} from "./organization-store.js";

type ObjectValue = Record<string, unknown>;
export function objectValue(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`migration-invalid: ${label}`);
  return value as ObjectValue;
}
export function sessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.~-]{0,255}$/.test(value))
    throw new Error("migration-invalid: sessionId");
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`migration-invalid: ${label}`);
  return value;
}
const META_KEYS = new Set([
  "sessionId",
  "cwd",
  "createdAt",
  "updatedAt",
  "harnessId",
  "nativeRef",
  "selection",
  "lastUsed",
  "permissionModeId",
  "title",
  "blank",
  "lastPromptAt",
  "nativeSessionId",
  "backfill",
  "checkpoints",
  "origin",
  "parentSessionId",
  "nativeSubagentId",
]);

export function validateLegacyIndex(
  input: unknown,
  home: string,
): { index: ObjectValue; excludedDraftIds: string[] } {
  const source = objectValue(input, "index"),
    index: ObjectValue = {},
    excludedDraftIds: string[] = [];
  const nativeOwners = new Set<string>();
  for (const [id, value] of Object.entries(source)) {
    sessionId(id);
    const meta = objectValue(value, id);
    if (Object.keys(meta).some((key) => !META_KEYS.has(key)))
      throw new Error(`migration-schema-unsupported: ${id}`);
    if (
      meta.sessionId !== id ||
      typeof meta.blank !== "boolean" ||
      !isAbsolute(text(meta.cwd, "cwd"))
    )
      throw new Error(`migration-invalid: metadata ${id}`);
    for (const key of ["createdAt", "updatedAt"])
      if (typeof meta[key] !== "number" || !Number.isFinite(meta[key]))
        throw new Error(`migration-invalid: ${key}`);
    for (const key of [
      "permissionModeId",
      "title",
      "nativeSessionId",
      "nativeSubagentId",
      "parentSessionId",
    ])
      if (meta[key] !== undefined && typeof meta[key] !== "string")
        throw new Error(`migration-invalid: ${key}`);
    if (
      meta.lastPromptAt !== undefined &&
      (typeof meta.lastPromptAt !== "number" || !Number.isFinite(meta.lastPromptAt))
    )
      throw new Error("migration-invalid: lastPromptAt");
    if (meta.nativeRef === undefined && meta.blank === true && meta.origin !== "subagent") {
      excludedDraftIds.push(id);
      continue;
    }
    if (meta.harnessId !== "codex") throw new Error(`migration-source-conflict: ${id}`);
    if (meta.nativeRef !== undefined) {
      const ref = objectValue(meta.nativeRef, "nativeRef"),
        locator = objectValue(ref.locator, "locator");
      if (
        ref.harnessId !== "codex" ||
        canonicalSessionPath(text(locator.codexHome, "codexHome")) !== home ||
        locator.codexHome !== home
      )
        throw new Error(`migration-home-conflict: ${id}`);
      const native = text(ref.nativeSessionId, "nativeSessionId");
      if (meta.nativeSessionId !== undefined && meta.nativeSessionId !== native)
        throw new Error(`migration-native-identity-conflict: ${id}`);
      if (meta.origin !== "subagent") {
        if (nativeOwners.has(native))
          throw new Error(`migration-native-identity-conflict: ${native}`);
        nativeOwners.add(native);
      }
    }
    if (
      meta.backfill !== undefined &&
      !["pending", "done", "failed"].includes(String(meta.backfill))
    )
      throw new Error("migration-invalid: backfill");
    if (meta.checkpoints !== undefined) {
      for (const [turn, checkpoint] of Object.entries(
        objectValue(meta.checkpoints, "checkpoints"),
      )) {
        if (!/^[1-9]\d*$/.test(turn)) throw new Error("migration-invalid: checkpoint turn");
        objectValue(checkpoint, "checkpoint");
      }
    }
    if (meta.origin !== undefined && meta.origin !== "subagent")
      throw new Error("migration-invalid: origin");
    for (const key of ["selection", "lastUsed"]) {
      if (meta[key] === undefined) continue;
      const selection = objectValue(meta[key], key);
      if (
        selection.provider !== "codex" ||
        typeof selection.model !== "string" ||
        !selection.model ||
        (selection.reasoningEffort !== undefined && typeof selection.reasoningEffort !== "string")
      )
        throw new Error(`migration-invalid: ${key}`);
    }
    index[id] = meta;
  }
  for (const [id, value] of Object.entries(index)) {
    const meta = objectValue(value, id);
    if (meta.origin === "subagent") {
      const parent = sessionId(meta.parentSessionId);
      if (!(parent in index) || parent === id || typeof meta.nativeSubagentId !== "string")
        throw new Error(`migration-parent-invalid: ${id}`);
      const seen = new Set([id]);
      let current: ObjectValue = meta;
      while (current.parentSessionId !== undefined) {
        const next = sessionId(current.parentSessionId);
        if (seen.has(next) || !(next in index)) throw new Error(`migration-parent-invalid: ${id}`);
        seen.add(next);
        current = objectValue(index[next], next);
      }
    } else if (meta.parentSessionId !== undefined || meta.nativeSubagentId !== undefined)
      throw new Error(`migration-parent-invalid: ${id}`);
  }
  return { index, excludedDraftIds };
}

export function validateLegacyJournal(bytes: Buffer, id: string): void {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let seq = 0; seq < lines.length; seq++) {
    const line = lines[seq];
    if (!line?.trim()) throw new Error(`migration-journal-invalid: ${id}:${seq}`);
    let event: ObjectValue;
    try {
      event = objectValue(JSON.parse(line), "event");
    } catch {
      throw new Error(`migration-journal-invalid: ${id}:${seq}`);
    }
    if (
      event.seq !== seq ||
      typeof event.type !== "string" ||
      !event.type ||
      typeof event.time !== "number" ||
      !Number.isFinite(event.time) ||
      !("data" in event)
    )
      throw new Error(`migration-journal-invalid: ${id}:${seq}`);
  }
}

export function migrateLegacyOrganization(
  input: unknown,
  ids: ReadonlySet<string>,
): {
  state: LocalOrganizationState;
  excludedExternalReferences: string[];
  excludedReferenceWorkspaceIds: string[];
} {
  const source = objectValue(input, "workspaces"),
    state = emptyLocalOrganization();
  if (
    Object.keys(source).some(
      (key) => !["items", "archivedSessionIds", "pinnedSessionIds"].includes(key),
    )
  )
    throw new Error("migration-schema-unsupported: workspaces");
  if (!Array.isArray(source.items)) throw new Error("migration-invalid: workspaces.items");
  const excludedExternalReferences = new Set<string>(),
    excludedReferenceWorkspaceIds: string[] = [],
    workspaceIds = new Set<string>(),
    memberships = new Set<string>();
  const filterIds = (value: unknown): string[] => {
    if (!Array.isArray(value)) throw new Error("migration-invalid: session references");
    const result: string[] = [];
    for (const entry of value) {
      const id = sessionId(entry);
      if (ids.has(id)) {
        if (result.includes(id)) throw new Error("migration-duplicate-reference");
        result.push(id);
      } else excludedExternalReferences.add(id);
    }
    return result;
  };
  for (const raw of source.items) {
    const item = objectValue(raw, "workspace"),
      id = text(item.workspaceId, "workspaceId");
    if (workspaceIds.has(id)) throw new Error("migration-duplicate-workspace");
    workspaceIds.add(id);
    const references = filterIds(item.sessionIds);
    if (item.origin !== "web") {
      excludedReferenceWorkspaceIds.push(id);
      continue;
    }
    if (!isAbsolute(text(item.path, "workspace.path")) || typeof item.title !== "string")
      throw new Error("migration-invalid: workspace");
    for (const key of ["createdAt", "updatedAt"])
      if (typeof item[key] !== "string" || !Number.isFinite(Date.parse(item[key])))
        throw new Error(`migration-invalid: ${key}`);
    for (const ref of references) {
      if (memberships.has(ref)) throw new Error("migration-duplicate-membership");
      memberships.add(ref);
    }
    state.items.push({
      workspaceId: id,
      path: item.path,
      title: item.title,
      sessionIds: references,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      origin: "web",
    } as LocalWorkspace);
  }
  state.archivedSessionIds = filterIds(source.archivedSessionIds);
  state.pinnedSessionIds = filterIds(source.pinnedSessionIds);
  return {
    state,
    excludedExternalReferences: [...excludedExternalReferences],
    excludedReferenceWorkspaceIds,
  };
}
