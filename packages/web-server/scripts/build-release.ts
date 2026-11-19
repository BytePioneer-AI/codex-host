/** Build release Web resources without touching the standalone packed distribution. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packReleaseWeb } from "../src/pack-release.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    platform: { type: "string" },
    architecture: { type: "string" },
  },
});
if (!values.output || !values.platform || !values.architecture) {
  throw new Error("Expected --output <app-directory> --platform <platform> --architecture <arch>");
}
const root = resolve(import.meta.dirname, "../../..");
const browserBuild = mkdtempSync(join(tmpdir(), "codexhost-release-browser-"));
try {
  execFileSync(
    process.execPath,
    ["--import", "tsx", "apps/web-ui/scripts/build.ts", "--output", browserBuild],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  await packReleaseWeb({
    root,
    app: resolve(values.output),
    browserBuild,
    platform: values.platform,
    architecture: values.architecture,
  });
} finally {
  rmSync(browserBuild, { recursive: true, force: true });
}
