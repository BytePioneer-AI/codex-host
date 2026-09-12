import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReleaseCi, readReleaseMetadata, resolveRelease, verifyRelease } from "../index.mjs";
import { ci, head, oldHead, repo } from "./fixtures.mjs";

const exec = promisify(execFile);
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository({
  version = "1.2.3",
  cargoVersion = version,
  lockVersion = version,
  notes = "Release 1.2.3\n\nFix history recovery.",
  annotated = true,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-release-guard-"));
  roots.push(root);
  async function git(...args) {
    const { stdout } = await exec(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: root },
    );
    return stdout.trim();
  }
  await git("init", "--initial-branch=main");
  await git("config", "core.hooksPath", path.join(root, "no-hooks"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "codexhost", version }));
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: "codexhost",
      version: lockVersion,
      packages: { "": { name: "codexhost", version: lockVersion } },
    }),
  );
  await writeFile(
    path.join(root, "Cargo.toml"),
    `[workspace]\nmembers=[]\n[workspace.package]\nversion = "${cargoVersion}"\n`,
  );
  await git("add", ".");
  await git("commit", "-m", "fixture");
  const sha = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/remotes/origin/main", sha);
  const tag = `v${version}`;
  if (annotated) await git("tag", "-a", tag, "-m", notes);
  else await git("tag", tag);
  return { root, sha, tag, git };
}

function githubFixture(sha = head) {
  const state = ci({ head_sha: sha });
  return {
    paginate: vi.fn(async (method, args) => (await method(args)).data),
    rest: {
      actions: {
        getWorkflow: vi.fn(async () => ({ data: { id: 1, path: ".github/workflows/ci.yml" } })),
        listWorkflowRuns: vi.fn(async () => ({ data: [state.run] })),
        listJobsForWorkflowRun: vi.fn(async () => ({ data: state.jobs })),
      },
      git: { getRef: vi.fn(async () => ({ data: { object: { type: "tag", sha: oldHead } } })) },
      repos: {
        compareCommits: vi.fn(async () => ({
          data: { status: "ahead", merge_base_commit: { sha } },
        })),
      },
    },
  };
}

describe("release source and metadata", () => {
  it("resolves an immutable annotated tag, matching versions, notes and trusted automation SHA", async () => {
    const f = await repository();
    const result = await readReleaseMetadata(f);
    expect(result).toMatchObject({
      version: "1.2.3",
      tag: "v1.2.3",
      sha: f.sha,
      automationSha: f.sha,
      npmTag: "latest",
      prerelease: false,
    });
    expect(result.notes).toContain("Fix history recovery");
    expect(result.tagObjectSha).toBe(await f.git("rev-parse", "refs/tags/v1.2.3"));
    expect(await f.git("status", "--porcelain")).toBe("");
  });

  it.each([
    ["1.2.3-test.1", "test"],
    ["1.2.3-beta.1", "next"],
    ["1.2.3+build.1", "latest"],
  ])("retains npm routing for %s", async (version, npmTag) => {
    const f = await repository({ version });
    expect((await readReleaseMetadata(f)).npmTag).toBe(npmTag);
  });

  it("rejects lightweight tags and empty release-note bodies", async () => {
    await expect(readReleaseMetadata(await repository({ annotated: false }))).rejects.toThrow(
      "annotated tag",
    );
    await expect(readReleaseMetadata(await repository({ notes: "Subject only" }))).rejects.toThrow(
      "body must contain release notes",
    );
  });

  it("rejects inconsistent package, Cargo and lockfile versions", async () => {
    const mismatch = await repository();
    await mismatch.git("tag", "-a", "v1.2.4", "-m", "Release\n\nNotes");
    await expect(readReleaseMetadata({ ...mismatch, tag: "v1.2.4" })).rejects.toThrow(
      "does not match package.json",
    );
    await expect(readReleaseMetadata(await repository({ cargoVersion: "1.2.4" }))).rejects.toThrow(
      "Cargo workspace version",
    );
    await expect(readReleaseMetadata(await repository({ lockVersion: "1.2.4" }))).rejects.toThrow(
      "package-lock.json",
    );
  });

  it("rejects malformed refs, moved triggering refs and commits outside main", async () => {
    const f = await repository();
    await expect(readReleaseMetadata({ ...f, tag: "v1.2.3; touch bad" })).rejects.toThrow(
      "valid semver",
    );
    await expect(readReleaseMetadata({ ...f, expectedRefSha: head })).rejects.toThrow("moved");
    await f.git("checkout", "-b", "other");
    await writeFile(path.join(f.root, "extra.txt"), "not integrated");
    await f.git("add", ".");
    await f.git("commit", "-m", "outside main");
    await f.git("tag", "-f", "-a", f.tag, "-m", "Release\n\nNotes");
    await expect(readReleaseMetadata(f)).rejects.toThrow();
  });

  it("reads tag files as data without checking out or running their scripts", async () => {
    const f = await repository();
    const before = await f.git("rev-parse", "HEAD");
    await writeFile(
      path.join(f.root, "package.json"),
      JSON.stringify({ name: "codexhost", version: "9.9.9", scripts: { prepare: "exit 1" } }),
    );
    expect((await readReleaseMetadata(f)).version).toBe("1.2.3");
    expect(await f.git("rev-parse", "HEAD")).toBe(before);
  });
});

describe("exact-commit CI release gate", () => {
  it("requires all four successful jobs for the exact main-push commit", () => {
    expect(assertReleaseCi(ci(), head)).toMatchObject({ ciRunId: 42, ciRunAttempt: 1 });
    expect(() => assertReleaseCi(ci(), oldHead)).toThrow("exact release commit");
    expect(() => assertReleaseCi(ci({ event: "pull_request" }), head)).toThrow("main push");
    expect(() => assertReleaseCi({ jobs: [] }, head)).toThrow("evidence");
  });

  it.each(["failure", "cancelled", "skipped", "action_required", "timed_out", null])(
    "rejects %s CI even if an older run was green",
    (conclusion) => {
      expect(() => assertReleaseCi(ci({ conclusion }), head)).toThrow("not successful");
    },
  );

  it("rejects queued, missing, skipped and duplicate jobs rather than accepting a green workflow", () => {
    expect(() => assertReleaseCi(ci({ status: "queued" }), head)).toThrow("not successful");
    for (const jobs of [
      [],
      ci().jobs.slice(1),
      [...ci().jobs, ci().jobs[0]],
      ci().jobs.map((job, index) => (index ? job : { ...job, conclusion: "skipped" })),
    ]) {
      expect(() => assertReleaseCi({ ...ci(), jobs }, head)).toThrow("successful job");
    }
  });

  it("combines trusted metadata with exact-head CI provenance", async () => {
    const f = await repository();
    const result = await resolveRelease({ ...f, repo, github: githubFixture(f.sha) });
    expect(result).toMatchObject({ sha: f.sha, ciRunId: 42, ciRunAttempt: 1 });
  });

  it("rejects publication if main was rewritten to remove the prepared commit", async () => {
    const github = githubFixture();
    github.rest.repos.compareCommits.mockResolvedValue({
      data: { status: "diverged", merge_base_commit: { sha: oldHead } },
    });
    await expect(
      verifyRelease({
        github,
        repo,
        tag: "v1.2.3",
        sha: head,
        tagObjectSha: oldHead,
        ciRunId: 42,
        ciRunAttempt: 1,
      }),
    ).rejects.toThrow("no longer on main");
  });

  it("revalidates the remote annotated tag and bound CI attempt before publication", async () => {
    const github = githubFixture();
    const input = {
      github,
      repo,
      tag: "v1.2.3",
      sha: head,
      tagObjectSha: oldHead,
      ciRunId: 42,
      ciRunAttempt: 1,
    };
    expect(await verifyRelease(input)).toMatchObject({ ciRunId: 42 });
    await expect(verifyRelease({ ...input, tagObjectSha: head })).rejects.toThrow("tag changed");
    await expect(verifyRelease({ ...input, ciRunAttempt: 2 })).rejects.toThrow("attempt changed");
    github.rest.actions.listWorkflowRuns.mockResolvedValue({
      data: [ci({ conclusion: "failure" }).run],
    });
    await expect(verifyRelease(input)).rejects.toThrow("not successful");
  });
});
