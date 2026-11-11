/** Read only registered Desktop projects. Migrated local projects remain visible
 * even when the legacy sidebar order contains only remote or newer project IDs. */
export function desktopProjectDefinitions(
  state: Record<string, unknown>,
  nativeScopeKey: string,
): Array<{ id: string; name: string; rootPaths: string[] }> {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const local = state["local-projects"];
  if (!record(local)) return [];
  const order = state["project-order"];
  const ordered = new Set(Array.isArray(order) ? order.filter((id) => typeof id === "string") : []);
  const mappings = state["app-server-project-id-by-legacy-project-id-by-host"];
  const scoped = record(mappings) ? mappings[nativeScopeKey] : undefined;
  const migrated = record(scoped) ? scoped : {};
  return Object.values(local).flatMap((project) => {
    if (
      !record(project) ||
      typeof project.id !== "string" ||
      typeof project.name !== "string" ||
      !Array.isArray(project.rootPaths) ||
      !project.rootPaths.every((root) => typeof root === "string")
    )
      return [];
    const nativeId = migrated[project.id];
    if (!ordered.has(project.id) && !(typeof nativeId === "string" && nativeId.length > 0))
      return [];
    return [{ id: project.id, name: project.name, rootPaths: project.rootPaths }];
  });
}
