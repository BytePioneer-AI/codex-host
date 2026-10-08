import { h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import {
  cacheHitRate,
  cost,
  inputWithoutCache,
  tokenCount,
  tokenSummary,
  tokensWithCache,
  unmetered,
  type Totals,
} from "./format.js";

/** Overview totals and their three non-overlapping token buckets, shared by both surfaces. */
export function summaryTiles(
  document: Document,
  totals: Totals,
  messages: ConsoleMessages["usageStatistics"],
  locale: string,
): HTMLElement {
  const tile = (
    key: string,
    label: string,
    value: string,
    approximation: string | null = null,
  ): HTMLElement =>
    h(
      document,
      "div",
      { className: "console-usage-tile", "data-tile": key },
      h(document, "span", { className: "console-usage-tile__label" }, label),
      h(
        document,
        "strong",
        {},
        value,
        approximation
          ? h(document, "small", { className: "console-usage-tile__detail" }, ` ${approximation}`)
          : null,
      ),
    );

  const total = tokensWithCache(totals);
  const tokens = unmetered(totals)
    ? { value: "—", approximation: null }
    : tokenSummary(total, locale);
  const tokenTile = tile("tokens", messages.tokenUsage, tokens.value, tokens.approximation);
  const unknownInput = totals.inputTokens - totals.cacheKnownInputTokens;
  const cache = totals.cachedInputTokens + totals.cacheWriteInputTokens;
  const parts = [
    {
      key: "input",
      label: messages.input,
      value: tokenCount(totals, inputWithoutCache(totals), locale),
    },
    {
      key: "output",
      label: messages.output,
      value: tokenCount(totals, totals.outputTokens, locale),
    },
    {
      key: "cache",
      label: messages.cache,
      value:
        totals.cacheKnownInputTokens === 0 && unknownInput > 0
          ? "—"
          : tokenCount(totals, cache, locale),
    },
  ];
  tokenTile.append(
    h(
      document,
      "div",
      { className: "console-usage-tile__breakdown" },
      ...parts.map((part) =>
        h(
          document,
          "span",
          {
            className: "console-usage-tile__part",
            "data-token-part": part.key,
          },
          h(document, "span", { className: "console-usage-tile__part-label" }, part.label),
          " ",
          h(document, "span", { className: "console-usage-tile__part-value" }, part.value),
        ),
      ),
    ),
  );
  return h(
    document,
    "div",
    { className: "console-usage-tiles" },
    tile("cost", messages.cost, cost(totals)),
    tokenTile,
    tile("cache", messages.cacheHitRate, cacheHitRate(totals)),
  );
}
