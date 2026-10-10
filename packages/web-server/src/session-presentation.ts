/** Browser-facing views of the owning Harness's native configuration, not Host presets. */
import type { Inspection, PermissionModeCatalog } from "./harnesses.ts";

export interface NativePermissionView {
  harnessId: string;
  catalog: PermissionModeCatalog | null;
  selectable: boolean;
  scope: "live" | "atCreate";
  locked: boolean;
}

/** Derive selectable native modes without inventing a fallback for unsupported Harnesses.
 * @param harnessId Owning Harness identity.
 * @param inspection Native Adapter inspection.
 * @param created Whether a native session already exists.
 * @param configuration Optional live session capabilities.
 * @returns Session-scoped native permission metadata.
 */
export function nativePermissionView(
  harnessId: string,
  inspection: Inspection,
  created: boolean,
  configuration?: { selectPermissionMode: boolean; permissionModeScope?: "live" | "atCreate" },
): NativePermissionView {
  const capability =
    configuration ??
    (inspection.status === "ready" ? inspection.capabilities.configuration : undefined);
  const scope = capability?.permissionModeScope ?? "live";
  const catalog =
    inspection.status === "ready" && capability?.selectPermissionMode === true
      ? (inspection.permissionModes ?? null)
      : null;
  return {
    harnessId,
    catalog,
    scope,
    selectable: catalog !== null,
    locked: scope === "atCreate" && created,
  };
}
