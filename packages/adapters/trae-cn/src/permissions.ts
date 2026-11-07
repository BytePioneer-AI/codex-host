import {
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeId,
  type HarnessPermissionModeCatalog,
} from "@codexhost/shared-contracts";
import type { BridgeInspection } from "./protocol.js";
import type { BridgeClient } from "./bridge.js";
import { record, TraeError } from "./errors.js";

export const permissionModeRef = (native: string): HarnessPermissionModeId =>
  harnessPermissionModeIdSchema.parse(`trae.permission.${native}`);

export function permissionCatalog(
  inspection: BridgeInspection,
): HarnessPermissionModeCatalog | undefined {
  const native = inspection.permissions;
  return native
    ? {
        modes: native.modes.map((mode) => ({
          ...mode,
          id: permissionModeRef(mode.id),
          localizations: {
            "zh-CN": {
              label:
                (
                  {
                    manual_approval: "手动审批",
                    auto_approval: "自动审批",
                    full_access: "完全访问",
                    defaultCustomProfile: "自定义",
                  } as Record<string, string>
                )[mode.id] ?? mode.label,
            },
          },
        })),
        defaultModeId: permissionModeRef(native.defaultModeId),
      }
    : undefined;
}

export function nativePermissionId(
  inspection: BridgeInspection,
  requested: HarnessPermissionModeId,
): string {
  if (!inspection.permissions)
    throw new TraeError(
      "unsupported",
      "TRAE CN permission selection is disabled or requires a newer Companion",
    );
  const selected = inspection.permissions.modes.find(
    (mode) => permissionModeRef(mode.id) === requested,
  );
  if (!selected)
    throw new TraeError("invalidRequest", "Permission mode is no longer available in TRAE CN");
  return selected.id;
}

export async function preparePermissionSelection(
  client: BridgeClient,
  inspection: BridgeInspection,
  requested: HarnessPermissionModeId,
  sessionId?: string,
): Promise<void> {
  const native = nativePermissionId(inspection, requested);
  const receipt = await client.call("preparePermission", {
    permissionModeId: native,
    ...(sessionId ? { sessionId } : {}),
  });
  if (!record(receipt) || receipt.permissionModeId !== native)
    throw new TraeError("protocolError", "TRAE CN did not confirm the prepared permission mode");
}
