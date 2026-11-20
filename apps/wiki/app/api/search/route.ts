import { createTokenizer } from "@orama/tokenizers/mandarin";
import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const { GET } = createFromSource(source, {
  localeMap: {
    zh: { tokenizer: createTokenizer() },
    en: "english",
  },
});
