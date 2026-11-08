import { expect, it } from "vitest";
it.each([
  [
    "darwin",
    "/Applications/codexhost.app/Contents/Resources/app/host-runtime.mjs",
    "/Applications/codexhost.app/Contents/MacOS/codexhost",
  ],
  ["darwin", "/opt/pkg/app/host-runtime.mjs", "/opt/pkg/bin/codexhost"],
  ["linux", "/opt/pkg/app/host-runtime.mjs", "/opt/pkg/bin/codexhost"],
] as const)("resolves the %s shared Host launcher for %s", async (platform, runtime, launcher) => {
  const { sharedHostLauncherPath } = await import("../src/local-shared-host.js");
  expect(sharedHostLauncherPath(runtime, {}, platform)).toBe(launcher);
  expect(
    sharedHostLauncherPath(
      runtime,
      { CODEXHOST_LAUNCHER_EXECUTABLE: "/explicit/launcher" },
      platform,
    ),
  ).toBe("/explicit/launcher");
});
