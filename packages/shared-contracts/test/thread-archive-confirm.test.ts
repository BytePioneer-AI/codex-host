import { expect, it } from "vitest";
import {
  CLIENT_CHANNEL_METHODS,
  THREAD_ARCHIVE_CONFIRM_METHOD,
  threadArchiveConfirmParamsSchema,
  threadArchiveConfirmResultSchema,
} from "../src/index.js";

it("exports the allowlisted strict native archive confirmation contract", () => {
  expect(CLIENT_CHANNEL_METHODS).toContain(THREAD_ARCHIVE_CONFIRM_METHOD);
  expect(threadArchiveConfirmParamsSchema.parse({ threadId: "native" })).toEqual({
    threadId: "native",
  });
  for (const value of [
    {},
    { threadId: "" },
    { threadId: 1 },
    { threadId: "native", extra: true },
  ]) {
    expect(threadArchiveConfirmParamsSchema.safeParse(value).success).toBe(false);
  }
  for (const confirmed of [true, false]) {
    expect(threadArchiveConfirmResultSchema.parse({ confirmed })).toEqual({ confirmed });
  }
  for (const value of [{}, { confirmed: "true" }, { confirmed: true, archived: true }]) {
    expect(threadArchiveConfirmResultSchema.safeParse(value).success).toBe(false);
  }
});
