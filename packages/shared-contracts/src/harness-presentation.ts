import { z } from "zod";

const localeSchema = z
  .string()
  .max(64)
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u);
const displayText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((text) => text.trim().length > 0);

/** Display-only plugin data. Never carries commands, IDs, risk flags or HTML. */
export const harnessLocalizationsSchema = z
  .record(
    localeSchema,
    z
      .object({
        label: displayText(256).optional(),
        description: displayText(1_024).optional(),
      })
      .strict(),
  )
  .refine((entries) => Object.keys(entries).length <= 16, "Too many locales");
export type HarnessLocalizations = z.infer<typeof harnessLocalizationsSchema>;

export const harnessLocalizedTextSchema = z
  .record(localeSchema, displayText(4_096))
  .refine((entries) => typeof entries.en === "string", "English fallback is required")
  .refine((entries) => Object.keys(entries).length <= 16, "Too many locales");
export type HarnessLocalizedText = z.infer<typeof harnessLocalizedTextSchema>;

function translation<T>(
  entries: Readonly<Record<string, T>> | undefined,
  locale: string,
): T | undefined {
  if (!entries) return undefined;
  const language = locale.split("-")[0] ?? locale;
  for (const candidate of [locale, language]) {
    if (Object.hasOwn(entries, candidate)) return entries[candidate];
  }
  return undefined;
}

/** Resolve each field independently; unknown locales retain the plugin's original wording. */
export function localizeHarnessPresentation(
  value: {
    label: string;
    description?: string | undefined;
    localizations?: HarnessLocalizations | undefined;
  },
  locale: string,
): { label: string; description: string | undefined } {
  const localized = translation(value.localizations, locale);
  const language = translation(value.localizations, locale.split("-")[0] ?? locale);
  return {
    label: localized?.label ?? language?.label ?? value.label,
    description: localized?.description ?? language?.description ?? value.description,
  };
}

export function localizeHarnessText(value: HarnessLocalizedText, locale: string): string {
  return translation(value, locale) ?? value.en ?? "";
}
