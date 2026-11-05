import { expect, it } from "vitest";

import { matchesBearerToken } from "../src/bearer-token.js";

it("accepts only the exact Bearer token", () => {
  expect(matchesBearerToken("Bearer synthetic-token", "synthetic-token")).toBe(true);
  for (const header of [
    undefined,
    "",
    "synthetic-token",
    "bearer synthetic-token",
    "Bearer ",
    "Bearer synthetic-tokeN",
    "Bearer synthetic-token ",
    "Bearer synthetic",
    "Basic synthetic-token",
  ]) {
    expect(matchesBearerToken(header, "synthetic-token"), String(header)).toBe(false);
  }
});
