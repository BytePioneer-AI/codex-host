import { readFile } from "node:fs/promises";
import path from "node:path";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import { AREAS, CI_JOBS } from "../src/policy.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file) => readFile(path.join(root, file), "utf8");

describe("workflow and form contracts", () => {
  it.each([
    ".github/workflows/repository-maintenance.yml",
    ".github/workflows/release-packages.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/question.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ])("parses %s as YAML", async (file) => {
    await expect(format(await read(file), { parser: "yaml" })).resolves.toBeTypeOf("string");
  });

  it("keeps every Area dropdown aligned with deterministic mappings", async () => {
    for (const name of ["bug_report", "feature_request", "question"]) {
      const source = await read(`.github/ISSUE_TEMPLATE/${name}.yml`);
      for (const area of Object.keys(AREAS)) expect(source).toContain(`- ${area}\n`);
      const ids = [...source.matchAll(/^\s+id: (\S+)$/gmu)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("keeps CI job names synchronized with the actual matrix", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    expect(workflow).toContain("name: Check ${{ matrix.os }}");
    for (const name of CI_JOBS.filter((value) => value !== "Check Linux ARM64")) {
      expect(workflow).toContain(`- ${name.slice("Check ".length)}\n`);
    }
    expect(workflow).toContain("name: Check Linux ARM64");
  });

  it("runs write-capable maintenance only with trusted code and no dependency installation", async () => {
    const workflow = await read(".github/workflows/repository-maintenance.yml");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toContain("  pull_request:");
    expect(workflow).not.toContain("  pull_request_review:");
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toMatch(
      /npm (?:ci|install)|OPENAI_API_KEY|gh pr merge|convertPullRequestToDraft/u,
    );
    expect(workflow).not.toMatch(/github\.event\.(?:issue|pull_request)\.(?:body|title)/u);
  });

  it("pins external Actions and release build/publish checkouts to immutable SHAs", async () => {
    for (const file of [
      ".github/workflows/repository-maintenance.yml",
      ".github/workflows/release-packages.yml",
    ]) {
      const workflow = await read(file);
      for (const [, reference] of workflow.matchAll(/uses: (\S+)/gu))
        expect(reference).toMatch(/@[a-f0-9]{40}$/u);
    }
    const workflow = await read(".github/workflows/release-packages.yml");
    expect(workflow).not.toContain("ref: ${{ needs.prepare.outputs.tag }}");
    expect(workflow.match(/ref: \$\{\{ needs\.prepare\.outputs\.commit_sha \}\}/gu)).toHaveLength(
      3,
    );
    expect(
      workflow.match(/ref: \$\{\{ needs\.prepare\.outputs\.automation_sha \}\}/gu),
    ).toHaveLength(2);
    expect(workflow.match(/await verifyRelease\(/gu)).toHaveLength(2);
    expect(workflow).toContain("release-evidence.json");
  });
});
