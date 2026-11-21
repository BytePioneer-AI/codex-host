import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";

import { isPlatformTest } from "./platform-tests.mjs";

const root = path.resolve(import.meta.dirname, "..");
const files = globSync("packages/web-server/test/*.test.ts", { cwd: root })
  .map((file) => path.join(root, file))
  .filter((file) => process.env.CODEXHOST_TEST_SCOPE !== "platform" || isPlatformTest(file));

// Node's test runner with no file arguments would discover unrelated suites.
if (!files.length) throw new Error("No Web Host tests selected");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...process.argv.slice(2), ...files],
  {
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
