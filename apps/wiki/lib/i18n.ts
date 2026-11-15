import { defineI18n } from "fumadocs-core/i18n";

export const i18n = defineI18n({
  languages: ["zh", "en"],
  defaultLanguage: "zh",
  fallbackLanguage: "zh",
});

export type Locale = "zh" | "en";

export function isLocale(value: string): value is Locale {
  return value === "zh" || value === "en";
}
