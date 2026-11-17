import { llms } from "fumadocs-core/source";
import { i18n } from "@/lib/i18n";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export function GET() {
  const docs = llms(source);
  return new Response(i18n.languages.map((lang) => docs.index(lang)).join("\n\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
