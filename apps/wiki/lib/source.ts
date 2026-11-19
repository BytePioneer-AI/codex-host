import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { entries } from "@/lib/entries";
import { i18n } from "@/lib/i18n";

const content = docs.toFumadocsSource();
const authored = loader({ baseUrl: "/docs", i18n, source: content });

// Reserved homepage destinations share the two minimal MDX placeholders.
// Authored pages (including the zh translation fallback) always take precedence.
const placeholders = i18n.languages.flatMap((lang) => {
  const template = authored.getPage([], lang);
  if (!template) throw new Error(`Missing documentation index for ${lang}`);

  return entries
    .filter((entry) => !authored.getPage(entry.slug.split("/"), lang))
    .map((entry) => ({
      type: "page" as const,
      path: `${entry.slug}.${lang}.mdx`,
      data: {
        ...template.data,
        title: entry.title[lang],
      },
    }));
});

const scaffoldContent: typeof content = {
  files: [...content.files, ...placeholders],
};

export const source = loader({
  baseUrl: "/docs",
  i18n,
  source: scaffoldContent,
});
