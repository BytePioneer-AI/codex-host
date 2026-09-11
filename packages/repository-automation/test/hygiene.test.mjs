import { describe, expect, it } from "vitest";
import { exceptionCommand, findHygieneException, inspectHygiene } from "../src/hygiene.mjs";
import { comment, head, oldHead } from "./fixtures.mjs";

function file(lines, filename = "packages/example/test/example.test.ts") {
  return {
    filename,
    status: "modified",
    additions: lines.length,
    patch: `@@ -1,1 +10,${lines.length} @@\n-old\n${lines.map((line) => `+${line}`).join("\n")}`,
  };
}

describe("advisory changed-line hygiene", () => {
  it("reports focused, skipped, suppression and Rust ignore changes with added-line numbers", () => {
    const result = inspectHygiene([
      file([
        "test.only('x', () => {});",
        "describe.skip('x', () => {});",
        "// @ts-expect-error intentional",
        "/* eslint-disable no-unused-vars */",
      ]),
      file(["#[ignore]", "#[allow(dead_code)]"], "crates/shim/src/lib.rs"),
    ]);
    expect(result.findings.map((entry) => entry.code)).toEqual([
      "focused-test",
      "skipped-test",
      "type-suppression",
      "lint-suppression",
      "ignored-rust-test",
      "rust-lint-suppression",
    ]);
    expect(result.findings[1].line).toBe(11);
  });

  it("ignores removed/context lines, docs, explicit fixture directories and inline string examples", () => {
    const source = file(["const example = \"test.only('example')\";", "// test.skip('example')"]);
    source.patch += "\n-test.only('removed')\n test.only('context')";
    const ignored = file(["test.only('example')"], "tests/fixtures/example.ts");
    expect(
      inspectHygiene([source, ignored, file(["test.only('example')"], "README.md")]).findings,
    ).toEqual([]);
  });

  it("reports unavailable or truncated patches rather than declaring a clean diff", () => {
    expect(inspectHygiene([{ filename: "a.ts", additions: 1 }], 2)).toEqual({
      findings: [],
      unavailable: ["a.ts"],
      incomplete: true,
    });
    const truncated = { ...file(["test.only('one')"]), additions: 100 };
    expect(inspectHygiene([truncated]).unavailable).toEqual([truncated.filename]);
  });

  it("does not mistake increment expressions inside a hunk for a diff file header", () => {
    const source = file(["++count;", "test.only('one')"]);
    expect(inspectHygiene([source]).unavailable).toEqual([]);
    expect(inspectHygiene([source]).findings[0].line).toBe(11);
  });

  it("does not demand a new test for every source or documentation change", () => {
    expect(inspectHygiene([file(["// Clarify this comment."])]).findings).toEqual([]);
  });
});

describe("explicit current-head maintainer exceptions", () => {
  const grant = (sha = head) =>
    comment({ body: `/codexhost hygiene-exception ${sha} intentional regression fixture` });
  it("requires current maintainer permission, not author association or a checkbox", async () => {
    for (const permission of ["read", "triage", "none"]) {
      expect(
        await findHygieneException({
          comments: [grant()],
          headSha: head,
          permissionFor: async () => permission,
        }),
      ).toBeNull();
    }
    expect(
      await findHygieneException({
        comments: [grant()],
        headSha: head,
        permissionFor: async () => "maintain",
      }),
    ).toMatchObject({ sha: head, revoked: false });
  });
  it("does not inherit an exception after a push", async () => {
    expect(
      await findHygieneException({
        comments: [grant(oldHead)],
        headSha: head,
        permissionFor: async () => "admin",
      }),
    ).toBeNull();
  });
  it("honors a newer explicit revocation", async () => {
    const revoke = comment({
      id: 2,
      body: `/codexhost hygiene-exception revoke ${head}`,
      updated_at: "2026-09-03T12:00:00Z",
    });
    expect(
      await findHygieneException({
        comments: [grant(), revoke],
        headSha: head,
        permissionFor: async () => "write",
      }),
    ).toBeNull();
  });
  it("ignores bot requests and fenced example commands", () => {
    expect(
      exceptionCommand({ ...grant(), user: { type: "Bot", login: "coderabbitai[bot]" } }),
    ).toBeNull();
    expect(
      exceptionCommand(
        comment({ body: `\`\`\`\n/codexhost hygiene-exception ${head} example only\n\`\`\`` }),
      ),
    ).toBeNull();
  });
});
