import {
  harnessPluginDescriptorSchema,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

/** The same bounded presentation contract used by Desktop; no SVG markup or
 * executable plugin code crosses into the browser. Original image bytes stay
 * on the existing /harness-icons/:id endpoint. */
export function harnessIconStyles(
  plugins: Iterable<{ id: string; iconStyle?: unknown }>,
): Record<string, HarnessPluginDescriptor["iconStyle"] | null> {
  return Object.fromEntries(
    [...plugins].map((plugin) => {
      const parsed = harnessPluginDescriptorSchema.shape.iconStyle.safeParse(plugin.iconStyle);
      return [plugin.id, parsed.success ? (parsed.data ?? null) : null];
    }),
  );
}
