import { describe, expect, it } from "vitest";

import {
  createNpmReleaseAvailability,
  npmReleasePackages,
  prefetchNpmRelease,
  type NpmCommandResult,
} from "../src/npm-registry.js";

const target = {
  nodePath: "/prefix/bin/node",
  npmCliPath: "/prefix/lib/node_modules/npm/bin/npm-cli.js",
  packageRoot: "/prefix/lib/node_modules/@codexhost/cli-darwin-arm64",
  version: "1.2.3",
};
const published = { code: 0, stdout: "1.2.3\n", stderr: "" };
const unsynced = { code: 0, stdout: "", stderr: "" };
const notFound = { code: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" };
const offline = {
  code: 1,
  stdout: "",
  stderr: "npm error code ENOTFOUND\nnpm error network request failed",
};

/** A registry answering `npm view` per package name. */
function registry(answers: Record<string, NpmCommandResult>) {
  const asked: string[] = [];
  return {
    asked,
    run: async (_target: unknown, arguments_: readonly string[]) => {
      const spec = arguments_[1] as string;
      asked.push(spec);
      return answers[spec.slice(0, spec.lastIndexOf("@"))] ?? published;
    },
  };
}

describe("npm release availability", () => {
  it("installs the CLI together with the platform package this installation runs", () => {
    expect(npmReleasePackages(target.packageRoot, "1.2.3")).toEqual([
      "@codexhost/cli@1.2.3",
      "@codexhost/cli-darwin-arm64@1.2.3",
    ]);
    expect(() => npmReleasePackages("/elsewhere/platform-package", "1.2.3")).toThrow(
      "Unknown platform package path",
    );
  });

  it.each([
    ["both packages are published", {}, true],
    ["the mirror has not synced the CLI", { "@codexhost/cli": unsynced }, false],
    ["the mirror has no platform package yet", { "@codexhost/cli-darwin-arm64": notFound }, false],
  ])("answers whether %s", async (_case, answers, expected) => {
    const availability = createNpmReleaseAvailability(registry(answers).run);
    await expect(availability.installable(target)).resolves.toBe(expected);
  });

  it("reports an unreachable registry instead of guessing", async () => {
    const availability = createNpmReleaseAvailability(registry({ "@codexhost/cli": offline }).run);
    await expect(availability.installable(target)).rejects.toThrow(
      "Could not query the npm registry: npm error code ENOTFOUND",
    );
  });

  it("asks the registry once for a published release and again later for a missing one", async () => {
    let time = 0;
    const answers: Record<string, NpmCommandResult> = { "@codexhost/cli": unsynced };
    const fake = registry(answers);
    const availability = createNpmReleaseAvailability(fake.run, () => time);

    const concurrent = await Promise.all([
      availability.installable(target),
      availability.installable(target),
    ]);
    expect(concurrent).toEqual([false, false]);
    expect(fake.asked).toHaveLength(2);

    time += 60_000;
    await expect(availability.installable(target)).resolves.toBe(false);
    expect(fake.asked).toHaveLength(2);

    delete answers["@codexhost/cli"];
    time += 5 * 60_000;
    await expect(availability.installable(target)).resolves.toBe(true);
    time += 24 * 60 * 60_000;
    await expect(availability.installable(target)).resolves.toBe(true);
    expect(fake.asked).toHaveLength(4);
  });

  it.each([
    [notFound, "npm registry does not have codexhost 1.2.3 yet; retry later"],
    [offline, "npm could not download the update: npm error code ENOTFOUND"],
  ])("explains a failed download", async (result, message) => {
    await expect(prefetchNpmRelease(target, async () => result)).rejects.toThrow(message);
  });
});
