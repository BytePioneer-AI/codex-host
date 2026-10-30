import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import type { RendererSettingsLocale } from "./localization.js";

export function harnessHasInstallCommands(plugin?: HarnessPluginDescriptor): boolean {
  return (plugin?.installation?.commands.length ?? 0) > 0;
}

export function harnessInstallationGuide(
  plugin: HarnessPluginDescriptor | undefined,
  locale: RendererSettingsLocale,
) {
  const guide = plugin?.installation;
  const text = (
    value: { en: string; "zh-CN"?: string | undefined } | undefined,
  ): string | undefined => value?.[locale] ?? value?.en;
  return {
    url: plugin?.links?.installation ?? plugin?.links?.documentation ?? plugin?.links?.website,
    commands: guide?.commands ?? [],
    downloads: guide?.downloads ?? [],
    before: text(guide?.before),
    after: text(guide?.after),
  };
}
