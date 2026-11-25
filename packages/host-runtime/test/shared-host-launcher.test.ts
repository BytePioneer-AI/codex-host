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

it("does not let legacy listener environments select cwd for an empty shared directory", async () => {
  const { sharedHostDataDirectory } = await import("../src/local-shared-host.js");
  const path = await import("node:path");
  const home = path.resolve("/profile"),
    custom = path.join(home, "custom");
  expect(sharedHostDataDirectory({ HOME: home, CODEXHOST_SHARED_DATA_DIR: "" })).toBe(
    path.join(home, ".codexhost"),
  );
  for (const value of [undefined, "", "  "])
    expect(sharedHostDataDirectory({ CODEXHOST_SHARED_DATA_DIR: value }, home)).toBe(
      path.join(home, ".codexhost"),
    );
  expect(sharedHostDataDirectory({ CODEXHOST_SHARED_DATA_DIR: custom }, home)).toBe(custom);
  expect(() => sharedHostDataDirectory({ CODEXHOST_SHARED_DATA_DIR: "relative" }, home)).toThrow(
    "absolute path",
  );
});
