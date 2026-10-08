import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  harnessPluginDescriptorSchema,
  harnessPluginManifestSchema,
} from "@codexhost/shared-contracts";

const adapters = new URL("../../packages/adapters/", import.meta.url);
export const testPluginIds = readdirSync(adapters).filter((id) =>
  existsSync(new URL(`${id}/manifest.json`, adapters)),
);

/** Presentation fixtures belong to the plugin, not a second Renderer branding table. */
export function pluginDescriptor(id: string) {
  const manifest = harnessPluginManifestSchema.parse(
    JSON.parse(readFileSync(new URL(`${id}/manifest.json`, adapters), "utf8")),
  );
  return harnessPluginDescriptorSchema.strip().parse({ ...manifest, icon: undefined });
}
