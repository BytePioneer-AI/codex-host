import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { syntheticFixtureSchema } from "./contracts.mjs";
import { overallStatus } from "./report.mjs";
import { createSyntheticFixture, writeSyntheticFixture } from "./synthetic-fixture.mjs";
import { assertLocalEvidencePath, gateCLocalRoot } from "./workspace.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fixturePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "gate-c",
  "hermetic.fixture.json",
);

describe("Gate C local evidence and synthetic fixture", () => {
  it("matches the explicitly generated Fake Pi golden without updating it", async () => {
    const reviewed = syntheticFixtureSchema.parse(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
    expect(await createSyntheticFixture()).toEqual(reviewed);
  });

  it("writes the explicit fixture in repository Prettier format", async () => {
    const parent = path.join(repositoryRoot, ".codexhost");
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, "gate-c-fixture-test-"));
    try {
      const outputPath = path.join(directory, "generated.json");
      await writeSyntheticFixture(outputPath);
      const contents = fs.readFileSync(outputPath, "utf8");
      expect(contents).toContain('"evidence": ["fake-pi:interleaved"]');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps real evidence under the ignored Gate C root", () => {
    const root = gateCLocalRoot(repositoryRoot);
    expect(assertLocalEvidencePath(repositoryRoot, path.join(root, "raw", "capture.json"))).toBe(
      path.join(root, "raw", "capture.json"),
    );
    expect(() =>
      assertLocalEvidencePath(repositoryRoot, path.join(repositoryRoot, "tests", "capture.json")),
    ).toThrow("must remain");
  });

  it("derives FAIL before BLOCKED and ignores optional failures", () => {
    const base = {
      profile: "hermetic",
      checks: {},
      evidence: [],
    };
    expect(
      overallStatus([
        { ...base, id: "a", required: true, status: "BLOCKED" },
        { ...base, id: "b", required: true, status: "FAIL" },
      ]),
    ).toBe("FAIL");
    expect(
      overallStatus([
        { ...base, id: "a", required: true, status: "PASS" },
        { ...base, id: "b", required: false, status: "FAIL" },
      ]),
    ).toBe("PASS");
  });
});
