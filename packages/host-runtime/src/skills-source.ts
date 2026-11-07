import type { HarnessSkillsCatalogCapability } from "@codexhost/harness-adapter";

/** One harness's skill capability, duck-typed off the adapter by the Host. */
export interface HarnessSkillsSource {
  harness: string;
  label?: string | undefined;
  capability: HarnessSkillsCatalogCapability;
}
