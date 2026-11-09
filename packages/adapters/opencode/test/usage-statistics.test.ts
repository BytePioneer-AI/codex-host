import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createOpenCodeUsageStatistics, openCodeDatabasePath } from "../src/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "opencode-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it("has no source without a database", async () => {
  expect(await createOpenCodeUsageStatistics({ XDG_DATA_HOME: home }).listSources(signal)).toEqual(
    [],
  );
  expect(openCodeDatabasePath({ OPENCODE_DB: ":memory:" })).toBeNull();
});
