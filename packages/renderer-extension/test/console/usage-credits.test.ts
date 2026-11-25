import { expect, it } from "vitest";
import { costWithCredits } from "../../src/console/usage/credits.js";
import { emptyTotals } from "../../src/console/usage/format.js";

const options = { locale: "en", harnessName: (id: string) => id, unpriced: "Unpriced" };
const totals = { ...emptyTotals(), requests: 2, unpricedRequests: 2 };
const row = {
  harness: "workbuddy",
  model: "auto",
  credits: 14.81,
  reportedRequests: 1,
  requests: 2,
};

it("labels even a single credit source in a combined view, preserving zero and coverage", () => {
  expect(costWithCredits(totals, [row], options)).toEqual({
    primary: null,
    credits: [{ label: "workbuddy", amount: "14.81 credits" }],
    reportedRequests: 1,
  });
  expect(costWithCredits(totals, [{ ...row, credits: 0 }], options).credits[0]?.amount).toBe(
    "0 credits",
  );
  expect(
    costWithCredits({ ...totals, unpricedRequests: 0, unmeteredRequests: 2 }, [row], options)
      .primary,
  ).toBeNull();
});
it("omits the source only for its selected Harness", () => {
  expect(
    costWithCredits(totals, [row], { ...options, harness: "workbuddy" }).credits[0]?.label,
  ).toBeNull();
  expect(costWithCredits(totals, [row], { ...options, harness: "other" }).credits[0]?.label).toBe(
    "workbuddy",
  );
});
it("keeps USD as the primary amount, including known zero USD", () => {
  const result = costWithCredits({ ...totals, unpricedRequests: 0, costUsd: 1.23 }, [row], options);
  expect(result.primary).toBe("$1.23");
  expect(result.credits).toEqual([{ label: "workbuddy", amount: "14.81 credits" }]);
  expect(costWithCredits({ ...totals, unpricedRequests: 0 }, [row], options).primary).toMatch(
    /^\$0/,
  );
});
it("combines only models of the same Harness and keeps separate credit lines", () => {
  expect(
    costWithCredits(totals, [row, { ...row, model: "other", credits: 1 }], options).credits,
  ).toEqual([{ label: "workbuddy", amount: "15.81 credits" }]);
  expect(
    costWithCredits(totals, [row, { ...row, harness: "codebuddy", credits: 2 }], options).credits,
  ).toEqual([
    { label: "workbuddy", amount: "14.81 credits" },
    { label: "codebuddy", amount: "2 credits" },
  ]);
});
it("does not label unmetered requests as missing prices when neither unit is recorded", () => {
  expect(
    costWithCredits({ ...totals, unpricedRequests: 0, unmeteredRequests: 2 }, [], options).primary,
  ).toBe("—");
});

it("falls back to unpriced only when neither unit has a known value", () => {
  expect(costWithCredits(totals, undefined, options)).toEqual({
    primary: "Unpriced",
    credits: [],
    reportedRequests: 0,
  });
  expect(
    costWithCredits(totals, [{ ...row, credits: 0, reportedRequests: 0 }], options).primary,
  ).toBe("Unpriced");
  expect(
    costWithCredits({ ...totals, unpricedRequests: 0, costUsd: 1.23 }, [], options).primary,
  ).toBe("$1.23");
});
