import {
  DESKTOP_EXTENSION_SETTINGS_MAX_BYTES,
  hostExtensionSettingsSchema,
  hostExtensionsRpcSchemas,
  HOST_EXTENSIONS_RPC,
  type HostExtensionManifest,
  type HostExtensionSettings,
  type HostExtensionsRpcParams,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { HostExtensionInstallConflict, readHostExtension } from "./host-extension-files.js";
import {
  hostExtensionDataDirectory,
  ifMissing,
  readHostFile,
  utf8,
  withHostExtensionWrite,
  writePrivateExtensionFile,
  type HostExtensionLocation,
} from "./host-extension-io.js";

const NAME = "settings.json";
export class HostExtensionSettingsRevisionConflict extends Error {
  constructor(readonly settingsRevision: number) {
    super("Extension settings changed; refresh and try again");
  }
}

async function readStored(location: HostExtensionLocation): Promise<HostExtensionSettings> {
  return (
    (await ifMissing(async () =>
      hostExtensionSettingsSchema.parse(
        JSON.parse(
          utf8.decode(
            await readHostFile(
              await hostExtensionDataDirectory(location),
              NAME,
              DESKTOP_EXTENSION_SETTINGS_MAX_BYTES,
            ),
          ),
        ),
      ),
    )) ?? { settingsRevision: 0, values: {} }
  );
}

function validateValues(
  values: JsonObject,
  fields: HostExtensionManifest["settingsSchema"],
  strict: boolean,
): JsonObject {
  if (fields === undefined) return values;
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const effective = new Map(
    fields.flatMap(({ key, default: value }) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field) {
      if (strict) throw new Error(`Unknown extension setting: ${key}`);
      continue;
    }
    const valid = (() => {
      switch (field.type) {
        case "boolean":
          return typeof value === "boolean";
        case "string":
          return typeof value === "string";
        case "select":
          return field.options.some((option) => option.value === value);
        case "number":
        case "range":
          return (
            typeof value === "number" &&
            value >= (field.min ?? -Infinity) &&
            value <= (field.max ?? Infinity)
          );
      }
    })();
    if (valid) effective.set(key, value as string | number | boolean);
    else if (strict) throw new Error(`Invalid value for extension setting: ${key}`);
  }
  return Object.fromEntries(effective);
}

export async function readHostExtensionSettings(
  location: HostExtensionLocation & { activationId?: string | undefined },
) {
  const installed = await readHostExtension(location);
  if (location.activationId !== undefined && location.activationId !== installed?.activationId)
    throw new HostExtensionInstallConflict("Extension activation changed");
  const settings = await readStored(location);
  if (
    location.activationId !== undefined &&
    location.activationId !== (await readHostExtension(location))?.activationId
  )
    throw new HostExtensionInstallConflict("Extension activation changed");
  return {
    ...settings,
    // Settings from an older generation may no longer match. Retain them on disk for rollback.
    values: validateValues(settings.values, installed?.manifest.settingsSchema, false),
  };
}

/** Replace the shared JSON values. Omitted declared values fall back to manifest defaults. */
export async function writeHostExtensionSettings({
  dataDir,
  ...input
}: { dataDir: string } & HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.settingsSet>) {
  const params = hostExtensionsRpcSchemas[HOST_EXTENSIONS_RPC.settingsSet].params.parse(input);
  const location = { dataDir, id: params.id };
  return withHostExtensionWrite(dataDir, async (_, assertLocked) => {
    const installed = await readHostExtension(location);
    if (!installed) throw new Error("Extension is not installed");
    if (params.activationId !== undefined && params.activationId !== installed.activationId)
      throw new HostExtensionInstallConflict("Extension activation changed");
    const current = await readStored(location);
    if (current.settingsRevision !== params.expectedSettingsRevision)
      throw new HostExtensionSettingsRevisionConflict(current.settingsRevision);
    const values = validateValues(params.values, installed.manifest.settingsSchema, true);
    const next = hostExtensionSettingsSchema.parse({
      settingsRevision: current.settingsRevision + 1,
      values: params.values,
    });
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > DESKTOP_EXTENSION_SETTINGS_MAX_BYTES)
      throw new Error("Extension settings exceed 1 MiB");
    await writePrivateExtensionFile(
      await hostExtensionDataDirectory(location, true),
      NAME,
      text,
      assertLocked,
    );
    return { ...next, values };
  });
}
