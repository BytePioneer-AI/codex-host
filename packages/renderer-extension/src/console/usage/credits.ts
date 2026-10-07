import type { UsageStatisticsResult, UsageStatisticsTotals } from "@codexhost/shared-contracts";
import { cost } from "./format.js";

/** USD is primary; native credits remain separate, source-labelled display lines. */
export function costWithCredits(
  totals: UsageStatisticsTotals,
  rows: UsageStatisticsResult["credits"],
  options: {
    locale: string;
    harnessName: (id: string) => string;
    unpriced: string;
    harness?: string | null;
  },
): {
  primary: string | null;
  credits: { label: string | null; amount: string }[];
  reportedRequests: number;
} {
  const groups = new Map<string, number>();
  let reportedRequests = 0;
  for (const row of rows ?? []) {
    if (row.reportedRequests === 0) continue;
    groups.set(row.harness, (groups.get(row.harness) ?? 0) + row.credits);
    reportedRequests += row.reportedRequests;
  }
  const format = new Intl.NumberFormat(options.locale, { maximumFractionDigits: 6 });
  const credits = [...groups].map(([harness, amount]) => ({
    label: options.harness === harness ? null : options.harnessName(harness),
    amount: `${format.format(amount)} credits`,
  }));
  const usd = cost(totals);
  return {
    primary: usd !== "—" ? usd : credits.length ? null : options.unpriced,
    credits,
    reportedRequests,
  };
}
