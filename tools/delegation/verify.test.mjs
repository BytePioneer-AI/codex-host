import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listScenarioIds } from "./matrix.mjs";
import {
  commandUsesChildThreadCli,
  configurationFingerprint,
  HANDLERS,
  runVerify,
} from "./verify.mjs";
import {
  canonicalReviewText,
  parseChildThreadCliInvocation,
  requireSuccessfulThreadOutcome,
  reviewMentionsPlant,
} from "./verify-evidence.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifyPath = path.join(repositoryRoot, "tools/delegation/verify.mjs");

function run(args, env = process.env) {
  return spawnSync(process.execPath, [verifyPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
}

describe("delegation verify entry", () => {
  it("does not alias CREATION-03, TURN-04, or FLOW-01 onto unrelated handlers", () => {
    expect(HANDLERS["CREATION-03"]).not.toBe(HANDLERS["CREATION-02"]);
    expect(HANDLERS["TURN-04"]).not.toBe(HANDLERS["CREATION-01"]);
    expect(HANDLERS["FLOW-01"]).not.toBe(HANDLERS["CREATION-01"]);
    expect(HANDLERS["RECOVERY-02"]).not.toBe(HANDLERS["RECOVERY-01"]);
    expect(HANDLERS["RELEASE-04"]).not.toBe(HANDLERS["RELEASE-01"]);
    expect(HANDLERS["EVIDENCE-04"]).not.toBe(HANDLERS["EVIDENCE-01"]);
    expect(HANDLERS["SKILL-03"]).not.toBe(HANDLERS["TURN-01"]);
    expect(HANDLERS["TURN-02"]).not.toBe(HANDLERS["TURN-01"]);
    expect(HANDLERS["TURN-03"]).not.toBe(HANDLERS["TURN-01"]);
    expect(HANDLERS["RELEASE-02"]).not.toBe(HANDLERS["RELEASE-01"]);
    expect(HANDLERS["RELEASE-03"]).not.toBe(HANDLERS["RELEASE-01"]);
    expect(HANDLERS["OBSERVE-02"]).not.toBe(HANDLERS["OBSERVE-01"]);
    expect(HANDLERS["OBSERVE-03"]).not.toBe(HANDLERS["OBSERVE-01"]);
    expect(HANDLERS["OBSERVE-04"]).not.toBe(HANDLERS["OBSERVE-01"]);
    expect(HANDLERS["INPUT-02"]).not.toBe(HANDLERS["INPUT-01"]);
    expect(HANDLERS["EVIDENCE-02"]).not.toBe(HANDLERS["EVIDENCE-01"]);
    expect(HANDLERS["EVIDENCE-03"]).not.toBe(HANDLERS["EVIDENCE-01"]);
    expect(HANDLERS["SKILL-02"]).not.toBe(HANDLERS["SKILL-01"]);
    expect(HANDLERS["SKILL-04"]).not.toBe(HANDLERS["EVIDENCE-01"]);
    expect(HANDLERS["FLOW-02"]).not.toBe(HANDLERS["RECOVERY-01"]);
    expect(HANDLERS["FLOW-03"]).not.toBe(HANDLERS["OBSERVE-01"]);
  });

  it("configuration fingerprints use status.harnessId, not the configuration payload", () => {
    const status = {
      harnessId: "grok",
      cwd: "/workspace",
      configuration: {
        effective: {
          effectiveModel: { id: "model-a" },
          effectiveThinkingOptionId: "high",
          effectivePermissionModeId: "always-approve",
        },
        unknown: ["turn"],
      },
    };
    const configOnly = status.configuration;
    expect(configOnly.harnessId).toBeUndefined();
    expect(configurationFingerprint(status)).toEqual({
      harnessId: "grok",
      cwd: "/workspace",
      model: "model-a",
      thinking: "high",
      permission: "always-approve",
    });
  });

  it("SKILL-03 requires a real child send/wait command, not echo or the wrong target", () => {
    const child = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    expect(commandUsesChildThreadCli(`echo $CODEXHOST_CLI_PATH`, child)).toBe(false);
    expect(commandUsesChildThreadCli(`echo CODEXHOST_CLI_PATH thread send ${child}`, child)).toBe(
      false,
    );
    expect(commandUsesChildThreadCli(`$CODEXHOST_CLI_PATH thread read ${child}`, child)).toBe(
      false,
    );
    expect(
      commandUsesChildThreadCli(`$CODEXHOST_CLI_PATH thread send ${other} --message hi`, child),
    ).toBe(false);
    expect(
      commandUsesChildThreadCli(`$CODEXHOST_CLI_PATH thread send ${child} --message hi`, child),
    ).toBe(true);
    expect(commandUsesChildThreadCli(`codexhost thread wait ${child}`, child)).toBe(true);
    expect(
      commandUsesChildThreadCli(`printf '%s\\n' '$CODEXHOST_CLI_PATH thread wait ${child}'`, child),
    ).toBe(false);
    expect(
      parseChildThreadCliInvocation(`printf '%s\\n' 'codexhost thread wait ${child}'`, child),
    ).toEqual({
      action: null,
      unsupported: false,
    });
    expect(
      commandUsesChildThreadCli(
        `$CODEXHOST_CLI_PATH thread wait ${child} --timeout-ms 30000`,
        child,
      ),
    ).toBe(true);
    expect(
      parseChildThreadCliInvocation(`$CODEXHOST_CLI_PATH thread send ${child} --message hi`, child)
        .action,
    ).toBe("send");
  });

  it("FLOW-01 accepts only successful canonical reviewer results", () => {
    expect(reviewMentionsPlant("unable to read leak.py", "FLOW01_LEAKED_deadbeef")).toBe(true);
    expect(
      canonicalReviewText({
        result: { availability: "unavailable", message: "unable to read leak.py" },
      }),
    ).toBe("");
    expect(() =>
      requireSuccessfulThreadOutcome(
        {
          status: 0,
          stdout: JSON.stringify({
            error: { code: "INTERNAL_ERROR", message: "unable to read leak.py" },
          }),
        },
        "reviewer read",
        { requireAvailableResult: true },
      ),
    ).toThrow(/INTERNAL_ERROR/u);
    expect(() =>
      requireSuccessfulThreadOutcome(
        {
          status: 0,
          stdout: JSON.stringify({ status: "completed", timedOut: true }),
        },
        "reviewer wait",
      ),
    ).toThrow(/timed out/u);
    const ok = requireSuccessfulThreadOutcome(
      {
        status: 0,
        stdout: JSON.stringify({
          status: "completed",
          timedOut: false,
          result: {
            availability: "available",
            text: "leak.py still contains FLOW01_LEAKED_deadbeef",
          },
        }),
      },
      "reviewer read",
      { requireAvailableResult: true },
    );
    expect(reviewMentionsPlant(canonicalReviewText(ok), "FLOW01_LEAKED_deadbeef")).toBe(true);
  });

  it("FLOW-01 and SKILL-03 synthetic probes reject false-positive evidence", async () => {
    let scenario;
    let tasks = [];
    const server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        let result;
        if (req.url === "/v1/delegate/start") {
          const id = randomUUID();
          const turnId = randomUUID();
          tasks.push({ threadId: id, turnId, task: body.task });
          if (scenario === "FLOW-01" && String(body.task).includes("Make test_scheduler.py pass")) {
            await writeFile(
              path.join(body.cwd, "scheduler.py"),
              "completed = set()\ndef mark_done(task_id, required=()):\n    if all(item in completed for item in required):\n        completed.add(task_id)\n",
            );
            for (const args of [
              ["add", "scheduler.py", "test_scheduler.py"],
              [
                "-c",
                "user.name=Probe",
                "-c",
                "user.email=probe@example.com",
                "commit",
                "-m",
                "unrelated marker",
              ],
            ]) {
              const git = spawnSync("git", args, { cwd: body.cwd, encoding: "utf8" });
              if (git.status !== 0) throw new Error(git.stderr);
            }
          }
          result = {
            threadId: id,
            turnId,
            delegationId: randomUUID(),
            harnessId: "grok",
            status: "running",
          };
        } else if (req.url === "/v1/thread/wait") {
          result = { status: "completed", timedOut: false };
        } else if (req.url === "/v1/thread/read" && scenario === "FLOW-01") {
          result = { error: { code: "INTERNAL_ERROR", message: "unable to read leak.py" } };
        } else if (req.url === "/v1/thread/list") {
          result = {
            threads: tasks.map((task) => ({ threadId: task.threadId })),
            nextCursor: null,
          };
        } else if (req.url === "/v1/thread/evidence") {
          result = {
            items: [
              {
                itemId: "echo",
                kind: "command",
                completed: true,
                exitCode: 0,
                command: `printf '%s\\n' '$CODEXHOST_CLI_PATH thread wait ${tasks[0].threadId}'`,
              },
            ],
            nextCursor: null,
          };
        } else if (req.url === "/v1/thread/send") {
          result = { error: { code: "THREAD_BUSY", message: "busy" } };
        } else if (req.url === "/v1/thread/cancel") {
          result = { cancelled: true };
        } else {
          throw new Error(`unexpected route ${req.url}`);
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: error.message } }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      CODEXHOST_RUNTIME_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
      CODEXHOST_RUNTIME_TOKEN: "synthetic-only",
    };
    try {
      for (const id of ["FLOW-01", "SKILL-03"]) {
        scenario = id;
        tasks = [];
        const dir = await mkdtemp(path.join(os.tmpdir(), "codexhost-contract-negative-"));
        try {
          await expect(
            HANDLERS[id]({
              mode: "live",
              runDirectory: dir,
              dataDirectory: dir,
              childEnvironment: env,
            }),
          ).rejects.toThrow(
            id === "FLOW-01" ? /CLI failed|INTERNAL_ERROR/u : /completed Host CLI send\/wait/u,
          );
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("FLOW-01 immutable acceptance tests fail the planted scheduler", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-flow01-plant-"));
    try {
      await writeFile(
        path.join(cwd, "scheduler.py"),
        "completed = set()\n\ndef mark_done(task_id, required=()):\n    completed.add(task_id)\n",
      );
      const oracle = spawnSync("python3", ["-m", "unittest", "test_acceptance.py", "-q"], {
        cwd: path.join(repositoryRoot, "tools/delegation/fixtures/flow01"),
        env: { ...process.env, PYTHONPATH: cwd },
        encoding: "utf8",
      });
      expect(oracle.status).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("FLOW-01 immutable acceptance tests reject a weakened workspace test", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-flow01-weak-"));
    try {
      await writeFile(
        path.join(cwd, "scheduler.py"),
        "completed = set()\n\ndef mark_done(task_id, required=()):\n    completed.add(task_id)\n",
      );
      await writeFile(
        path.join(cwd, "test_scheduler.py"),
        "import unittest\nclass SelectionTest(unittest.TestCase):\n    def test_batch_does_not_complete_dependency(self):\n        self.assertTrue(True)\n",
      );
      const weakened = spawnSync("python3", ["-m", "unittest", "test_scheduler.py", "-q"], {
        cwd,
        encoding: "utf8",
      });
      expect(weakened.status).toBe(0);
      const oracle = spawnSync("python3", ["-m", "unittest", "test_acceptance.py", "-q"], {
        cwd: path.join(repositoryRoot, "tools/delegation/fixtures/flow01"),
        env: { ...process.env, PYTHONPATH: cwd },
        encoding: "utf8",
      });
      expect(oracle.status).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("FLOW-01 immutable acceptance tests pass a correct scheduler the writer cannot edit", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-flow01-fixed-"));
    try {
      await writeFile(
        path.join(cwd, "scheduler.py"),
        [
          "completed = set()",
          "",
          "def mark_done(task_id, required=()):",
          "    if all(item in completed for item in required):",
          "        completed.add(task_id)",
          "",
        ].join("\n"),
      );
      const oracle = spawnSync("python3", ["-m", "unittest", "test_acceptance.py", "-q"], {
        cwd: path.join(repositoryRoot, "tools/delegation/fixtures/flow01"),
        env: { ...process.env, PYTHONPATH: cwd },
        encoding: "utf8",
      });
      expect(oracle.status).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("FLOW-01 plant is a real failing unittest, not an idempotent set.add", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-flow01-plant-"));
    try {
      await writeFile(
        path.join(cwd, "scheduler.py"),
        "completed = set()\n\ndef mark_done(task_id, required=()):\n    completed.add(task_id)\n",
      );
      await writeFile(
        path.join(cwd, "test_scheduler.py"),
        [
          "import unittest",
          "from scheduler import mark_done, completed",
          "",
          "class SelectionTest(unittest.TestCase):",
          "    def test_batch_does_not_complete_dependency(self):",
          "        mark_done('child', required=('parent',))",
          "        self.assertNotIn('child', completed)",
          "",
        ].join("\n"),
      );
      const python = spawnSync("python3", ["-m", "unittest", "test_scheduler.py", "-q"], {
        cwd,
        encoding: "utf8",
      });
      expect(python.status).not.toBe(0);
      expect(`${python.stderr}${python.stdout}`).toMatch(
        /test_batch_does_not_complete_dependency/u,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ENTRY-01 lists unique scenarios and rejects invalid mode/scenario/output", async () => {
    const listed = run(["--list"]);
    expect(listed.status).toBe(0);
    const ids = listed.stdout.trim().split("\n");
    expect(ids).toEqual(listScenarioIds());
    expect(new Set(ids).size).toBe(ids.length);

    const invalidMode = run(["--mode", "fake", "--scenario", "ENTRY-01", "--output", os.tmpdir()]);
    expect(invalidMode.status).not.toBe(0);

    const invalidScenario = run([
      "--mode",
      "hermetic",
      "--scenario",
      "NOT-A-CASE",
      "--output",
      os.tmpdir(),
    ]);
    expect(invalidScenario.status).not.toBe(0);

    const unwritable = run([
      "--mode",
      "hermetic",
      "--scenario",
      "ENTRY-01",
      "--output",
      "/this/path/does/not/exist/and/cannot/be/created/verify-entry",
    ]);
    expect(unwritable.status).not.toBe(0);
  });

  it("ENTRY-02 does not target the inherited Desktop endpoint and redacts tokens", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "codexhost-verify-entry02-"));
    const inheritedEndpoint = "http://127.0.0.1:65530";
    const inheritedToken = "inherited-secret-token-value";
    const previousEndpoint = process.env.CODEXHOST_RUNTIME_ENDPOINT;
    const previousToken = process.env.CODEXHOST_RUNTIME_TOKEN;
    process.env.CODEXHOST_RUNTIME_ENDPOINT = inheritedEndpoint;
    process.env.CODEXHOST_RUNTIME_TOKEN = inheritedToken;
    try {
      const result = await runVerify([
        "--mode",
        "hermetic",
        "--scenario",
        "ENTRY-02",
        "--output",
        output,
      ]);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      expect(
        report.inheritedEndpoint === inheritedEndpoint || report.inheritedEndpoint === null,
      ).toBe(true);
      const json = JSON.stringify(report);
      expect(json).not.toContain(inheritedToken);
      expect(json).not.toMatch(/CODEXHOST_RUNTIME_TOKEN": "(?!\[redacted\])/u);
      if (report.scenarios[0]?.runtime?.endpoint) {
        expect(report.scenarios[0].runtime.endpoint).not.toBe(inheritedEndpoint);
      }
    } finally {
      if (previousEndpoint === undefined) delete process.env.CODEXHOST_RUNTIME_ENDPOINT;
      else process.env.CODEXHOST_RUNTIME_ENDPOINT = previousEndpoint;
      if (previousToken === undefined) delete process.env.CODEXHOST_RUNTIME_TOKEN;
      else process.env.CODEXHOST_RUNTIME_TOKEN = previousToken;
      await rm(output, { recursive: true, force: true });
    }
  });

  it("ENTRY-03 preserves scenario and cleanup failures and does not write the user repo", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "codexhost-verify-entry03-"));
    const leak = path.join(repositoryRoot, "entry-03-should-not-exist.txt");
    try {
      const result = await runVerify([
        "--mode",
        "hermetic",
        "--scenario",
        "ENTRY-03",
        "--output",
        output,
      ]);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      const details = report.scenarios[0]?.details;
      expect(details.scenarioError).toMatch(/synthetic scenario failure/u);
      expect(details.cleanupError).toMatch(/synthetic cleanup failure/u);
      await expect(readFile(leak, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(output, { recursive: true, force: true });
      await rm(leak, { force: true });
    }
  });
});
