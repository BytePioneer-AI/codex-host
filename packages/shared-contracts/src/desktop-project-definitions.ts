import { clientWorkspaceSnapshotSchema, type ClientWorkspaceSnapshot } from "./client-channel.js";

/** Read only registered Desktop projects. Migrated local projects remain visible
 * even when the legacy sidebar order contains only remote or newer project IDs. */
export function desktopProjectDefinitions(
  state: Record<string, unknown>,
  nativeScopeKey: string,
): ClientWorkspaceSnapshot["projects"] {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const local = state["local-projects"];
  if (!record(local)) return [];
  const order = state["project-order"];
  const ordered = new Set(Array.isArray(order) ? order.filter((id) => typeof id === "string") : []);
  const mappings = state["app-server-project-id-by-legacy-project-id-by-host"];
  const scoped = record(mappings) ? mappings[nativeScopeKey] : undefined;
  const migrated = record(scoped) ? scoped : {};
  const selected = new Map<string, ClientWorkspaceSnapshot["projects"][number]>();
  for (const project of Object.values(local)) {
    if (!record(project) || typeof project.id !== "string") continue;
    const nativeId = migrated[project.id];
    if (!ordered.has(project.id) && !(typeof nativeId === "string" && nativeId.length > 0))
      continue;
    // Validate selected rows before deduplication so a malformed duplicate is still rejected.
    const parsed = clientWorkspaceSnapshotSchema.shape.projects.element.parse(project);
    if (!selected.has(parsed.id)) selected.set(parsed.id, parsed);
  }
  const projects: ClientWorkspaceSnapshot["projects"] = [];
  for (const id of ordered) {
    const project = selected.get(id);
    if (!project) continue;
    projects.push(project);
    selected.delete(id);
  }
  return [...projects, ...selected.values()];
}
